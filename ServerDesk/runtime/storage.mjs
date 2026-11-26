import {createHash, randomUUID} from 'node:crypto';
import {constants, createWriteStream} from 'node:fs';
import {lstat, mkdir, open, readdir, realpath, rename, unlink} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

// One envelope keeps metadata and content in the same atomic filesystem rename.
// Objects use hashed paths; user-controlled keys never become filesystem paths.
const HEADER_SIZE = 16 * 1024;
const httpHeaders = {
  contentType: 'Content-Type', contentLanguage: 'Content-Language',
  contentDisposition: 'Content-Disposition', contentEncoding: 'Content-Encoding',
  cacheControl: 'Cache-Control', cacheExpiry: 'Expires',
};

function validateKey(key) {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024 || /[\u0000-\u001f\\]/.test(key)
      || key.startsWith('/') || key.split('/').some(part => part === '.' || part === '..') || /^[a-z]:/i.test(key)) {
    throw new TypeError('Invalid object storage key.');
  }
  return key;
}

function optionsMetadata(options = {}) {
  for (const option of Object.keys(options)) {
    if (!['httpMetadata', 'customMetadata'].includes(option)) throw new TypeError(`Unsupported object storage option: ${option}`);
  }
  const httpMetadata = options.httpMetadata instanceof Headers
    ? Object.fromEntries(Object.entries(httpHeaders).flatMap(([key, header]) => options.httpMetadata.has(header) ? [[key, options.httpMetadata.get(header)]] : []))
    : {...options.httpMetadata};
  if (httpMetadata.cacheExpiry !== undefined) httpMetadata.cacheExpiry = new Date(httpMetadata.cacheExpiry).toISOString();
  const customMetadata = {...options.customMetadata};
  for (const value of Object.values(customMetadata)) if (typeof value !== 'string') throw new TypeError('Object custom metadata values must be strings.');
  return {httpMetadata, customMetadata};
}

function objectMetadata(metadata) {
  const httpMetadata = {...metadata.httpMetadata};
  if (httpMetadata.cacheExpiry) httpMetadata.cacheExpiry = new Date(httpMetadata.cacheExpiry);
  return {
    key: metadata.key, version: metadata.version, size: metadata.size,
    etag: metadata.etag.replace(/^"|"$/g, ''), httpEtag: `"${metadata.etag.replace(/^"|"$/g, '')}"`,
    uploaded: new Date(metadata.uploaded), httpMetadata,
    customMetadata: {...metadata.customMetadata},
    writeHttpMetadata(headers) {
      for (const [key, header] of Object.entries(httpHeaders)) {
        const value = httpMetadata[key];
        if (value !== undefined) headers.set(header, value instanceof Date ? value.toUTCString() : value);
      }
    },
  };
}

function objectBody(metadata, stream) {
  const response = new Response(stream);
  return {
    ...objectMetadata(metadata), body: response.body,
    get bodyUsed() { return response.bodyUsed; },
    arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json(),
    blob: () => response.blob(),
  };
}

function inputStream(value) {
  if (value == null) return Readable.from([]);
  if (typeof value === 'string') return Readable.from([Buffer.from(value)]);
  if (value instanceof ArrayBuffer) return Readable.from([Buffer.from(value)]);
  if (ArrayBuffer.isView(value)) return Readable.from([Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
  if (value instanceof Blob) return Readable.fromWeb(value.stream());
  if (typeof value.getReader === 'function') return Readable.fromWeb(value);
  if (value instanceof Readable) return value;
  throw new TypeError('Unsupported object body.');
}

function listOptions(options = {}) {
  for (const option of Object.keys(options)) {
    if (!['prefix', 'cursor', 'limit'].includes(option)) throw new TypeError(`Unsupported object listing option: ${option}`);
  }
  const {prefix = '', cursor, limit = 1000} = options;
  if (typeof prefix !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid object listing options.');
  return {prefix, cursor, limit};
}

function notFound(error) { return error?.code === 'ENOENT'; }
// A missing container/account is a storage outage, not an absent object. In
// particular, the readiness sentinel must not hide Azure configuration errors.
function blobNotFound(error) {
  // HEAD errors have no XML body: the SDK exposes x-ms-error-code in details.
  return error?.statusCode === 404 && (error?.details?.errorCode ?? error?.code) === 'BlobNotFound';
}

// Filesystem layout, grouped by namespace (a key up to and including its last
// '/'), so a listing reads only the requested subtree instead of the bucket:
//   <root>/n/<nh[0:2]>/<nh>/o/<kh>.object  envelope; nh = sha256(namespace), kh = sha256(key)
//   <root>/n/<nh[0:2]>/<nh>/c/<ch>         marker for a direct child namespace; content = child, ch = sha256(child)
// Every component below the root is a fixed name or a sha256 hex digest.
const sha256 = value => createHash('sha256').update(value).digest('hex');
const namespaceOf = key => key.slice(0, key.lastIndexOf('/') + 1);
// 'a/b/' -> ['', 'a/', 'a/b/']
function namespaceChain(namespace) {
  const chain = [''];
  for (let index = namespace.indexOf('/'); index !== -1; index = namespace.indexOf('/', index + 1)) chain.push(namespace.slice(0, index + 1));
  return chain;
}
function isDirectChild(parent, child) {
  const rest = child.slice(parent.length);
  return child.startsWith(parent) && rest.length > 0 && rest.indexOf('/') === rest.length - 1;
}
const unsafeDirectory = () => new Error('Unsafe object storage directory.');
const unsafeFile = () => new Error('Unsafe object storage file.');
const ignoreMissing = error => {if (!notFound(error)) throw error;};
const OBJECT_NAME = /^[a-f0-9]{64}\.object$/, MARKER_NAME = /^[a-f0-9]{64}$/;

function filesystemBucket(location) {
  const configuredRoot = resolve(location);
  let initialization;
  // Walks fixed or hashed components below the root without following links.
  const directory = async (storageRoot, parts, create) => {
    let current = storageRoot;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let info = await lstat(current).catch(error => {ignoreMissing(error); return null;});
      if (!info && create) {
        await mkdir(current, {mode: 0o700}).catch(error => {if (error?.code !== 'EEXIST') throw error;});
        info = await lstat(current);
      }
      if (!info) return {path: join(current, ...parts.slice(index + 1)), exists: false};
      if (!info.isDirectory() || info.isSymbolicLink()) throw unsafeDirectory();
    }
    const rel = relative(storageRoot, await realpath(current));
    if (rel.startsWith('..') || resolve(storageRoot, rel) !== current) throw unsafeDirectory();
    return {path: current, exists: true};
  };
  const namespaceDirectory = (storageRoot, namespace, kind, create = false) => {
    const hash = sha256(namespace);
    return directory(storageRoot, ['n', hash.slice(0, 2), hash, kind], create);
  };
  const names = async (path, pattern) => (await readdir(path).catch(error => {ignoreMissing(error); return [];})).filter(name => pattern.test(name));
  const readEnvelope = async (file, expectedKey) => {
    let handle;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw unsafeFile();
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const header = Buffer.alloc(HEADER_SIZE);
      const {bytesRead} = await handle.read(header, 0, HEADER_SIZE, 0);
      if (bytesRead !== HEADER_SIZE) throw new Error('Corrupt object storage envelope.');
      const metadata = JSON.parse(header.toString('utf8').trim());
      validateKey(metadata.key);
      const actual = await handle.stat();
      if ((expectedKey !== undefined && metadata.key !== expectedKey) || actual.size !== HEADER_SIZE + metadata.size) throw new Error('Corrupt object storage envelope.');
      return {handle, metadata};
    } catch (error) {
      await handle?.close();
      if (notFound(error)) return null;
      throw error;
    }
  };
  // Markers are deterministic: an existing one is kept, and a concurrent writer stores the same content.
  const writeMarker = async (storageRoot, parent, child) => {
    const file = join((await namespaceDirectory(storageRoot, parent, 'c', true)).path, sha256(child));
    const existing = await lstat(file).catch(error => {ignoreMissing(error); return null;});
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw unsafeFile();
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(child);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file).catch(async error => {
        const info = await lstat(file).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink()) throw error;
      });
    } finally {
      await handle?.close();
      await unlink(temporary).catch(ignoreMissing);
    }
  };
  const readMarker = async (file, name, parent) => {
    let handle;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw unsafeFile();
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if ((await handle.stat()).size > 1024) throw new Error('Corrupt object storage marker.');
      const content = await handle.readFile();
      const child = content.toString('utf8');
      if (sha256(content) !== name || !isDirectChild(parent, child)) throw new Error('Corrupt object storage marker.');
      return child;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    } finally { await handle?.close(); }
  };
  // Ancestor markers exist before the object becomes visible, so a listing never misses it.
  const placeObject = async (storageRoot, key) => {
    const namespace = namespaceOf(key), chain = namespaceChain(namespace);
    for (let index = 1; index < chain.length; index++) await writeMarker(storageRoot, chain[index - 1], chain[index]);
    return join((await namespaceDirectory(storageRoot, namespace, 'o', true)).path, `${sha256(key)}.object`);
  };
  const root = () => initialization ??= (async () => {
    await mkdir(configuredRoot, {recursive: true, mode: 0o700});
    const storageRoot = await realpath(configuredRoot);
    return storageRoot;
  })().catch(error => {initialization = undefined; throw error;});
  const objectPath = async key => {
    validateKey(key);
    const storageRoot = await root();
    return join((await namespaceDirectory(storageRoot, namespaceOf(key), 'o')).path, `${sha256(key)}.object`);
  };
  return {
    async get(key, options) {
      if (options !== undefined) throw new TypeError('Object ranges and conditions are not supported by this adapter.');
      const envelope = await readEnvelope(await objectPath(key), key);
      if (!envelope) return null;
      return objectBody(envelope.metadata, Readable.toWeb(envelope.handle.createReadStream({start: HEADER_SIZE, autoClose: true})));
    },
    async head(key) {
      const envelope = await readEnvelope(await objectPath(key), key);
      if (!envelope) return null;
      await envelope.handle.close();
      return objectMetadata(envelope.metadata);
    },
    async put(key, value, options) {
      const extra = optionsMetadata(options);
      validateKey(key);
      const file = await placeObject(await root(), key);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.write(Buffer.alloc(HEADER_SIZE, 32), 0, HEADER_SIZE, 0);
        const hash = createHash('sha256');
        let size = 0;
        const measure = new Transform({transform(chunk, encoding, callback) {
          size += chunk.length; hash.update(chunk); callback(null, chunk);
        }});
        await pipeline(inputStream(value), measure, createWriteStream(temporary, {flags: constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), start: HEADER_SIZE}));
        const metadata = {key, size, etag: hash.digest('hex'), version: randomUUID(), uploaded: new Date().toISOString(), ...extra};
        const header = Buffer.from(JSON.stringify(metadata));
        if (header.length >= HEADER_SIZE) throw new TypeError('Object metadata exceeds the storage limit.');
        await handle.write(header, 0, header.length, 0);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, file);
        return objectMetadata(metadata);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(ignoreMissing);
      }
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      // Validate the complete request before deleting any object.
      list.forEach(validateKey);
      for (const key of list) await unlink(await objectPath(key)).catch(ignoreMissing);
    },
    async list(options) {
      const {prefix, cursor, limit} = listOptions(options);
      let after = '';
      if (cursor) {
        try {
          const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (parsed.prefix !== prefix || typeof parsed.after !== 'string') throw new Error();
          after = parsed.after;
        } catch { throw new TypeError('Invalid object listing cursor.'); }
      }
      // Start at the namespace containing the prefix and descend only into
      // child namespaces that start with it.
      const storageRoot = await root(), objects = [], pending = [namespaceOf(prefix)];
      while (pending.length) {
        const namespace = pending.pop();
        const objectDirectory = await namespaceDirectory(storageRoot, namespace, 'o');
        if (objectDirectory.exists) for (const name of await names(objectDirectory.path, OBJECT_NAME)) {
          const envelope = await readEnvelope(join(objectDirectory.path, name));
          if (!envelope) continue;
          await envelope.handle.close();
          const {key} = envelope.metadata;
          if (namespaceOf(key) !== namespace || `${sha256(key)}.object` !== name) throw new Error('Corrupt object storage envelope.');
          if (key.startsWith(prefix) && key > after) objects.push(objectMetadata(envelope.metadata));
        }
        const childDirectory = await namespaceDirectory(storageRoot, namespace, 'c');
        if (childDirectory.exists) for (const name of await names(childDirectory.path, MARKER_NAME)) {
          const child = await readMarker(join(childDirectory.path, name), name, namespace);
          if (child?.startsWith(prefix)) pending.push(child);
        }
      }
      objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const truncated = objects.length > limit, page = objects.slice(0, limit);
      return {objects: page, truncated, delimitedPrefixes: [], ...(truncated ? {cursor: Buffer.from(JSON.stringify({prefix, after: page.at(-1).key})).toString('base64url')} : {})};
    },
  };
}

function azureBucket(config) {
  let initialization;
  const container = () => initialization ??= (async () => {
    const {BlobServiceClient} = await import('@azure/storage-blob');
    let service;
    if (config.AZURE_STORAGE_CONNECTION_STRING) service = BlobServiceClient.fromConnectionString(config.AZURE_STORAGE_CONNECTION_STRING);
    else {
      if (!config.AZURE_STORAGE_ACCOUNT_URL) throw new Error('Azure storage requires AZURE_STORAGE_ACCOUNT_URL or AZURE_STORAGE_CONNECTION_STRING.');
      const {DefaultAzureCredential} = await import('@azure/identity');
      service = new BlobServiceClient(config.AZURE_STORAGE_ACCOUNT_URL, new DefaultAzureCredential());
    }
    return service.getContainerClient(config.AZURE_STORAGE_CONTAINER || 'serverdesk');
  })();
  const metadata = (key, response) => ({
    key, size: response.contentLength ?? 0, etag: response.etag ?? '',
    uploaded: (response.lastModified ?? new Date()).toISOString(), version: response.versionId ?? response.etag,
    customMetadata: response.metadata?.serverdeskmeta ? JSON.parse(Buffer.from(response.metadata.serverdeskmeta, 'base64url').toString()) : {},
    httpMetadata: Object.fromEntries([
      ['contentType', response.contentType], ['contentLanguage', response.contentLanguage],
      ['contentEncoding', response.contentEncoding], ['contentDisposition', response.contentDisposition],
      ['cacheControl', response.cacheControl],
      ['cacheExpiry', response.metadata?.serverdeskexpiry],
    ].filter(([, value]) => value !== undefined)),
  });
  return {
    async get(key, options) {
      validateKey(key);
      if (options !== undefined) throw new TypeError('Object ranges and conditions are not supported by this adapter.');
      try {
        const result = await (await container()).getBlobClient(key).download();
        if (!result.readableStreamBody) throw new Error('Azure object download returned no stream.');
        return objectBody(metadata(key, result), Readable.toWeb(result.readableStreamBody));
      } catch (error) { if (blobNotFound(error)) return null; throw error; }
    },
    async head(key) {
      validateKey(key);
      try { return objectMetadata(metadata(key, await (await container()).getBlobClient(key).getProperties())); }
      catch (error) { if (blobNotFound(error)) return null; throw error; }
    },
    async put(key, value, options) {
      validateKey(key);
      const extra = optionsMetadata(options), blob = (await container()).getBlockBlobClient(key);
      const h = extra.httpMetadata;
      const result = await blob.uploadStream(inputStream(value), 256 * 1024, 2, {
        metadata: {serverdeskmeta: Buffer.from(JSON.stringify(extra.customMetadata)).toString('base64url'), ...(h.cacheExpiry ? {serverdeskexpiry: h.cacheExpiry} : {})},
        blobHTTPHeaders: {blobContentType: h.contentType, blobContentLanguage: h.contentLanguage, blobContentEncoding: h.contentEncoding, blobContentDisposition: h.contentDisposition, blobCacheControl: h.cacheControl},
      });
      // Fetch this exact version's properties; fail on a concurrent replacement.
      const properties = await blob.getProperties({conditions: {ifMatch: result.etag}});
      return objectMetadata(metadata(key, properties));
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(validateKey);
      const target = await container();
      for (const key of list) await target.getBlobClient(key).deleteIfExists({deleteSnapshots: 'include'});
    },
    async list(options) {
      const {prefix, cursor, limit} = listOptions(options);
      const iterator = (await container()).listBlobsFlat({prefix, includeMetadata: true}).byPage({maxPageSize: limit, ...(cursor ? {continuationToken: cursor} : {})});
      const {value: page} = await iterator.next();
      const objects = (page?.segment.blobItems ?? []).map(item => objectMetadata(metadata(item.name, {...item.properties, metadata: item.metadata})));
      return {objects, truncated: Boolean(page?.continuationToken), delimitedPrefixes: [], ...(page?.continuationToken ? {cursor: page.continuationToken} : {})};
    },
  };
}

/** The object storage of the server: persistent NAS files or shared Azure Blob storage. */
export function createStorage(config = process.env) {
  const driver = config.OBJECT_STORAGE_DRIVER || 'filesystem';
  if (driver === 'filesystem') return filesystemBucket(config.OBJECT_STORAGE_PATH || '.data/objects');
  if (driver === 'azure') return azureBucket(config);
  throw new Error(`Unsupported OBJECT_STORAGE_DRIVER: ${driver}`);
}
