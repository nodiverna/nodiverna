// The object storage listing (runtime/storage.mjs): correct listings, large buckets, rejected child markers and
// old layouts that are not read (pnpm test:selfhost).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStorage} from '../../runtime/storage.mjs';

const HEADER_SIZE = 16 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'serverdesk-storage-listing-'));
let roots = 0;
const freshRoot = () => join(temporary, `root-${roots++}`);
const storage = root => createStorage({OBJECT_STORAGE_DRIVER: 'filesystem', OBJECT_STORAGE_PATH: root});
const keys = result => result.objects.map(object => object.key);
const namespaceDirectory = (root, namespace, kind) => {
  const hash = sha(namespace);
  return join(root, 'n', hash.slice(0, 2), hash, kind);
};
const exists = path => stat(path).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
async function* files(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}
async function headerKey(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);
    return JSON.parse(header.toString('utf8').trim()).key;
  } finally { await handle.close(); }
}
async function listAll(bucket, prefix, limit) {
  const pages = [];
  let cursor;
  do {
    const page = await bucket.list({prefix, limit, ...(cursor ? {cursor} : {})});
    pages.push(page);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return pages;
}
// The envelope format of the previous layout: <root>/<h[0:2]>/<h>.object.
async function writeOldLayout(root, key, body, extra = {}) {
  const hash = sha(key), directory = join(root, hash.slice(0, 2));
  const bytes = Buffer.from(body);
  const metadata = {
    key, size: bytes.length, etag: sha(bytes), version: `old-${hash.slice(0, 8)}`, uploaded: '2026-01-02T03:04:05.000Z',
    httpMetadata: {contentType: 'application/octet-stream'}, customMetadata: {origin: 'old-layout'}, ...extra,
  };
  const header = Buffer.alloc(HEADER_SIZE, 32);
  Buffer.from(JSON.stringify(metadata)).copy(header);
  await mkdir(directory, {recursive: true});
  const file = join(directory, `${hash}.object`);
  await writeFile(file, Buffer.concat([header, bytes]));
  return {file, directory, metadata};
}

try {
  // 1. Correctness on an intact bucket.
  {
    const bucket = storage(freshRoot());
    const all = [
      `archive/u1/0/${sha('a')}`, 'archive/u1/native/1/index.json', `archive/u2/0/${sha('b')}`,
      'transfers/a/0/x', 'transfers/ab/0/x', 'transfers/a-key', 'transfers/b/0/x', 'empty', 'a//b',
    ];
    for (const key of all) await bucket.put(key, key);
    const sorted = [...all].sort();
    assert.deepEqual(keys(await bucket.list({prefix: 'archive/u1/'})), [`archive/u1/0/${sha('a')}`, 'archive/u1/native/1/index.json']);
    assert.deepEqual(keys(await bucket.list({prefix: 'transfers/a'})), ['transfers/a-key', 'transfers/a/0/x', 'transfers/ab/0/x']);
    assert.deepEqual(keys(await bucket.list({prefix: 'transfers/a/'})), ['transfers/a/0/x']);
    assert.deepEqual(keys(await bucket.list({prefix: ''})), sorted);
    const everything = await bucket.list();
    assert.deepEqual(keys(everything), sorted);
    assert.deepEqual(everything.delimitedPrefixes, []);
    assert.equal(everything.truncated, false);
    assert.equal('cursor' in everything, false);
    assert.equal(await (await bucket.get('a//b')).text(), 'a//b');
    assert.equal((await bucket.head('a//b')).size, 4);
    assert.deepEqual(keys(await bucket.list({prefix: 'a/'})), ['a//b']);
    assert.deepEqual(keys(await bucket.list({prefix: 'a//'})), ['a//b']);

    const pages = await listAll(bucket, 'archive/u1/', 1);
    assert.deepEqual(pages.map(keys), [[`archive/u1/0/${sha('a')}`], ['archive/u1/native/1/index.json']]);
    assert.deepEqual(pages.map(page => page.truncated), [true, false]);
    await assert.rejects(bucket.list({prefix: 'transfers/', cursor: pages[0].cursor}), /cursor/);
    await assert.rejects(bucket.list({prefix: 'x/', limit: 1001}), /listing/);
    await assert.rejects(bucket.list({prefix: 'x/', limit: 1.5}), /listing/);
  }

  // 2. A large bucket with a small target: the listing never opens a foreign envelope.
  {
    const root = freshRoot(), bucket = storage(root);
    const foreign = [];
    for (let id = 0; id < 20; id++) for (let chunk = 0; chunk < 3; chunk++) for (let n = 0; n < 9; n++) foreign.push(`transfers/other-${id}/${chunk}/${sha(`${id}-${chunk}-${n}`)}`);
    for (let id = 0; id < 10; id++) {
      for (let n = 0; n < 5; n++) foreign.push(`archive/r${id}/${n}/${sha(`r${id}-${n}`)}`);
      foreign.push(`archive/r${id}/native/1/index.json`);
    }
    foreign.push(`transfers/target-x/0/${sha('look-alike')}`, 'transfers/targetx');
    assert.ok(foreign.length >= 600);
    for (let index = 0; index < foreign.length; index += 25) await Promise.all(foreign.slice(index, index + 25).map(key => bucket.put(key, key)));
    const target = [`transfers/target/0/${sha('t0')}`, `transfers/target/1/${sha('t1')}`, 'transfers/target/native/1/index.json'];
    for (const key of target) await bucket.put(key, key);

    let corrupted = 0;
    for await (const file of files(root)) {
      if (!file.endsWith('.object')) continue;
      if (!(await headerKey(file)).startsWith('transfers/target/')) {
        await writeFile(file, Buffer.from([0]));
        corrupted++;
      }
    }
    assert.equal(corrupted, foreign.length);
    await assert.rejects(bucket.head(foreign[0]), /Corrupt/);
    await assert.rejects(bucket.head('transfers/targetx'), /Corrupt/);

    const pages = await listAll(bucket, 'transfers/target/', 1);
    assert.deepEqual(pages.flatMap(keys), target);
    assert.deepEqual(pages.map(page => page.truncated), [true, true, false]);

    // The clearTransfer pattern: list one page, delete it, continue with the cursor.
    let cursor, deleted = 0;
    do {
      const page = await bucket.list({prefix: 'transfers/target/', limit: 1, ...(cursor ? {cursor} : {})});
      await bucket.delete(keys(page));
      deleted += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    assert.equal(deleted, 3);
    assert.deepEqual(keys(await bucket.list({prefix: 'transfers/target/'})), []);
    await assert.rejects(bucket.list({prefix: 'transfers/'}), /Corrupt/);
  }

  // 3. A child marker whose content does not match its name is rejected.
  {
    const root = freshRoot(), bucket = storage(root);
    await bucket.put('m/x/1', 'value');
    const markers = namespaceDirectory(root, 'm/', 'c');
    assert.deepEqual(await readdir(markers), [sha('m/x/')]);
    assert.equal(await readFile(join(markers, sha('m/x/')), 'utf8'), 'm/x/');
    await writeFile(join(markers, sha('m/x/')), 'other/');
    await assert.rejects(bucket.list({prefix: 'm/'}), /Corrupt/);
    // A marker with a matching name that is not a direct child is rejected too.
    await writeFile(join(markers, sha('m/x/y/')), 'm/x/y/');
    await writeFile(join(markers, sha('m/x/')), 'm/x/');
    await assert.rejects(bucket.list({prefix: 'm/'}), /Corrupt/);
    await rm(join(markers, sha('m/x/y/')));
    // In-flight temporary files are ignored.
    await writeFile(join(markers, `${sha('m/z/')}.${sha('tmp').slice(0, 8)}.tmp`), 'partial');
    assert.deepEqual(keys(await bucket.list({prefix: 'm/'})), ['m/x/1']);
  }

  // 4. Files in the old two-hex-shard or flat layout are neither migrated, listed nor returned.
  {
    const root = freshRoot();
    await mkdir(root, {recursive: true});
    const old = await writeOldLayout(root, 'transfers/old/0/aa', 'old chunk', {customMetadata: {sha256: 'proof'}});
    const flat = await writeOldLayout(root, 'flat-key', 'flat body');
    const bucket = storage(root);
    for (const file of [old, flat]) {
      assert.equal(await bucket.get(file.metadata.key), null, `${file.metadata.key}: not returned`);
      assert.equal(await bucket.head(file.metadata.key), null, `${file.metadata.key}: no metadata`);
    }
    assert.deepEqual(keys(await bucket.list({prefix: 'transfers/old/'})), []);
    assert.deepEqual(keys(await bucket.list()), []);
    for (const file of [old, flat]) assert.equal(await exists(file.file), true, 'the old file stays where it is, untouched');

    // A key written in the current layout is independent of an old file with the same key.
    await bucket.put('transfers/old/0/aa', 'new chunk');
    assert.equal(await (await bucket.get('transfers/old/0/aa')).text(), 'new chunk');
    assert.deepEqual(keys(await bucket.list()), ['transfers/old/0/aa']);
    await bucket.delete('transfers/old/0/aa');
    assert.equal(await bucket.get('transfers/old/0/aa'), null, 'deleting the new object does not bring back the old file');
    assert.equal(await exists(old.file), true);
  }

  // 5. A symlinked namespace directory is never followed.
  {
    const root = freshRoot(), bucket = storage(root);
    await bucket.put('linked/a', 'inside');
    const outside = join(temporary, 'outside-directory');
    await mkdir(outside);
    await writeFile(join(outside, 'secret'), 'must remain untouched');
    const objectDirectory = namespaceDirectory(root, 'linked/', 'o');
    await rm(objectDirectory, {recursive: true});
    try {
      // A junction needs no extra privileges on Windows; other platforms ignore the type.
      await symlink(outside, objectDirectory, 'junction');
      await assert.rejects(bucket.get('linked/a'), /Unsafe/);
      await assert.rejects(bucket.list({prefix: 'linked/'}), /Unsafe/);
      await assert.rejects(bucket.list(), /Unsafe/);
      await assert.rejects(bucket.put('linked/b', 'x'), /Unsafe/);
      // The same holds for a namespace's child-marker directory.
      await bucket.put('nested/x/1', 'inside');
      const markerDirectory = namespaceDirectory(root, 'nested/', 'c');
      await rm(markerDirectory, {recursive: true});
      await symlink(outside, markerDirectory, 'junction');
      await assert.rejects(bucket.list({prefix: 'nested/'}), /Unsafe/);
      await assert.rejects(bucket.put('nested/y/1', 'x'), /Unsafe/);
      assert.deepEqual(await readdir(outside), ['secret']);
      assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'must remain untouched');
    } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  }

  console.log('Self-host storage listing: namespace-limited listing, marker integrity and old-layout tests passed.');
} finally {
  // The test creates this unique absolute temporary directory itself.
  assert.ok(temporary.startsWith(join(tmpdir(), 'serverdesk-storage-listing-')));
  await rm(temporary, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
