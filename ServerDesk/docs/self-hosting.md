# Operate ServerDesk yourself

## Decision: one application image

ServerDesk uses Node.js 22 and Next.js in standalone mode. Custom adapters connect the portal to the database and the object storage. Users authenticate with local accounts and MFA. At the first installation, a one-time invitation makes an owner.

There is **one build and one unchanged production OCI image**. Compose and Azure Container Apps configure the environment of this image. You need different infrastructure manifests, but you do not need a second application implementation.

| Environment | Web | Database | Files |
| --- | --- | --- | --- |
| Development | Next dev, native or in a container | PostgreSQL 17 container (`pnpm db:local` or the Compose service `db`) | local file system |
| NAS / small server of your own | one Node replica, Caddy with HTTPS | PostgreSQL 17 container (Compose service `db`) | `/data/objects` |
| Azure Container Apps with scaling | the same image, many replicas | Azure Database for PostgreSQL Flexible Server 17 | Azure Blob Storage |

The production container runs as UID/GID 1000 and listens on the internal port 3000. It needs write access only to the persistent data directory. The container receives the secrets only at the start. The start validates the origin and the secrets. Database migrations are separate commands on purpose.

## Develop and test locally

Install Node.js 22.13 or later and pnpm 11.25.0. In the directory `ServerDesk`, run these commands:

```powershell
corepack enable
corepack prepare pnpm@11.25.0 --activate
node scripts/pipeline.mjs install
pnpm setup
pnpm db:local up
pnpm db:migrate
pnpm owner:bootstrap --username admin --display-name Administrator
pnpm dev
```

`pnpm setup` makes `.env.local` with independent random secrets and a random `DATABASE_PASSWORD`. It does not overwrite a file that exists. It only adds a missing `DATABASE_PASSWORD` or job-signing key.

`pnpm db:local up` starts the PostgreSQL 17 container `serverdesk-local-db` with Docker. The port is published only on `127.0.0.1`. The password comes from `.env.local`.

`pnpm db:local status` shows the state. `pnpm db:local down` removes the container and keeps the named volume with the data. Native development runs at `https://localhost:3000` with the local Next development certificate. Trust this certificate in your browser.

Open the invitation link from the output within 24 hours. Set the password and configure MFA. The second factor is a passkey or an authenticator app. For a passkey, `SITE_ORIGIN` must be a DNS name with HTTPS. At an IP address, ServerDesk offers only the authenticator app.

`bootstrap-owner` works only for the first installation. It does not change accounts that exist. Invitation links contain access tokens. Do not put them in public build logs.

```powershell
node scripts/pipeline.mjs verify
```

This pipeline runs `pnpm validate` and `pnpm test:http`. It checks the types, lint, business logic, and the permission and revocation rules on PostgreSQL. `pnpm test:http` copies the working tree to a temporary folder and pins a throwaway test publisher there (`scripts/test-publisher.mjs`). It builds this copy and runs the HTTP test on it, with the signed update path. It deletes the copy and the test key at the end and does not change your working tree.

The GitHub workflow `.github/workflows/ci.yml` runs the typecheck, lint, the tests, the dependency audit and `pnpm test:http` on each push to `dev` and on each pull request. It also runs the dependency audit one time each day.

`scripts/test-publisher.mjs pin` runs only in the copy of `pnpm test:http`. In a git checkout, it stops with exit code 1 and changes no file. It also refuses the production publisher key.

Each test file gets its own test database. The tests use the server in `TEST_DATABASE_URL` or start the container `serverdesk-test-postgres` with Docker. It also checks the storage adapters, the migration, the owner bootstrap and the real HTTP sign-in flow. The tests use isolated data. They do not use production data or local development accounts.

The CI test does not need the private publisher key. `tests/repo/release-publisher-pin.mjs` makes sure that no test publisher goes into the repository.

### Check the dependencies

`pnpm check:audit` checks the lockfile with `pnpm audit --audit-level high` against the advisory database of the npm registry. It needs network access. The workflow **CI** runs `pnpm check:audit` on each push to `dev`, on each pull request and one time each day. The workflow **Docker image** also runs it before each build. A critical or high finding makes the run fail. Offline, `pnpm test` only checks that the lockfile keeps the fixes below.

Next.js 16.4.6 fixes these advisories:

- GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr (critical, remote code execution).
- GHSA-p3m5-59mp-jv5r (high, denial of service).
- GHSA-mfr8-8qww-v76h, GHSA-vc7v-qv4w-wrv8, GHSA-rhh4-g77r-r9qj and GHSA-vvgp-ww4w-46vf (moderate, cache disclosure or cache poisoning).
- GHSA-7qx7-33qx-rqx2 (moderate, SVG rejection bypass in the image optimization).
- GHSA-f3mh-rxg3-f5g2 (moderate, HttpOnly cookie disclosure on Edge runtime routes).
- GHSA-pc58-hwjq-p385 (moderate, response injection between clients in self-hosted applications).

An override to esbuild 0.28.1 fixes GHSA-67mh-4wv8-2f99 (medium, only the dev server under drizzle-kit).

Two lockfile updates fix advisories without an override:

- GHSA-474x-hrwr-fgx4 (low, high CPU load on XML with an open stop-node tag). The package is `fast-xml-parser` under `@azure/storage-blob` and `@azure/core-xml`. The lockfile has `fast-xml-parser` 5.12.1, and the fix starts at 5.12.0.
- GHSA-g3hv-75wg-m249 (medium, denial of service from glob patterns). The package is `minimatch` in the lint toolchain (`eslint-config-next`, `typescript-eslint`). `typescript-eslint` 8.73.0 uses `minimatch` 11.0.8, and the fix starts at 11.0.1. `minimatch` 3.1.5 of the ESLint plugins is not in the affected range.

The audit ignores GHSA-vfj7-8cjw-p6xm in `braces` on purpose. No fixed version is available. The package is only in the lint toolchain (`eslint-config-next`), not in the image. It processes only patterns from this repository. When a fix is available, the entry `audit.ignore` in `pnpm-workspace.yaml` must go. `tests/repo/dependency-security.mjs` enforces this.

Docker development uses the same source with hot reload:

```powershell
Copy-Item deploy/runtime.env.example .env.runtime
# Edit .env.runtime: new secrets, SITE_ORIGIN=https://localhost:8443
docker compose --env-file .env.runtime -f compose.dev.yaml build
node scripts/pipeline.mjs migrate --dev
node scripts/pipeline.mjs bootstrap-owner --dev --username admin --display-name Administrator
node scripts/pipeline.mjs dev
```

Compose mounts the source directory at `/app`. Linux `node_modules`, `.next` and the development data are in separate named volumes. Thus, Linux does not run the Windows dependencies. In the Docker dev setup, Caddy terminates HTTPS at `https://localhost:8443`. The internal Next dev server runs without its own TLS.

To get the CA certificate, use `docker compose --env-file .env.runtime -f compose.dev.yaml cp proxy:/data/caddy/pki/authorities/local/root.crt ./serverdesk-root.crt`. Then trust the certificate as the procedure below shows. For agent functions, generate a matching public release signature as shown below. After a change of the lockfile, build the development image again. Also update the dependencies in the dev volume, for example with `docker compose --env-file .env.runtime -f compose.dev.yaml run --rm app pnpm install --frozen-lockfile`. `down` does not remove data volumes, but `down --volumes` deletes them.

## Your own publisher for the Windows agent

This section is only for a fork that builds and signs its own Windows agent. An installation of the published image does not need it: it imports the signed agent releases (refer to [Agent releases from GitHub](#agent-releases-from-github)).

The agent trusts the pinned publisher key in `agent/v3/release-public.pem` and `lib/release-publisher.json`. The matching private key is only in the ignored file `.data/release-private.pem`. Make an encrypted backup of it. For other build computers, supply it through a secret store or a secure file store. In a clone with a public key pin, restore the matching private key. Do not generate a new root of trust.

```powershell
# Check or initialize the existing local publisher; never rotate it without notice:
node scripts/init-publisher.mjs
# For agent changes: .NET SDK 10 is necessary; run pnpm install first.
$env:SERVERDESK_RELEASE_KEY_FILE = '.data/release-private.pem'
node scripts/pipeline.mjs agent
node scripts/agent-release.mjs assets --out outputs/agent-release
```

`agent` generates the registration and bootstrap files again and compiles the Windows agent into `.build/`. It makes the ZIP package with the JavaScript library `fflate`, without Python. Then it signs the release record `.build/agent-v3-release.json` with the key in `SERVERDESK_RELEASE_KEY_FILE` and checks the signature against the pinned public key. `agent-release.mjs assets` writes the five release files and `notes.md` into a folder. Publish this folder as a GitHub release of your fork, or import it on each portal with `selfhost.mjs import-release`. The image does not contain the agent, and `.dockerignore` excludes the private key.

If you change the publisher key, you must **reinstall the existing agents one time manually with the new EXE**. The agents must not accept an unchecked automatic rotation of their trust anchor.

The private publisher key stays on the build computer or in the GitHub environment `agent-signing`. Do not copy it to the NAS. Do not put it into the web image or into the configuration of a portal. The portal never signs.

## Production image and local Compose installation

In the directory `ServerDesk`, run these commands:

```powershell
Copy-Item deploy/runtime.env.example .env.runtime
# Configure .env.runtime with the origin and your own secrets.
node scripts/pipeline.mjs image --image serverdesk:local
node scripts/pipeline.mjs smoke --image serverdesk:local
node scripts/pipeline.mjs up --image serverdesk:local --migrate
node scripts/pipeline.mjs bootstrap-owner --username admin --display-name Administrator
```

Generate a new secret for `SESSION_SECRET` and a new secret for `PASSWORD_PEPPER`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

`AGENT_JOB_SIGNING_KEY` is the ECDSA P-256 key that the portal uses to sign each agent job. Agents 4.7.0 and later run only signed jobs. At installation, they get the public key from the registration file. Without this value, the portal does not make registrations. If you change the key, you must install all agents again. For more information, refer to [agent-broker-worker.md](agent-broker-worker.md).

```powershell
node -e "console.log(require('crypto').generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
```

You must replace the example values. `SITE_ORIGIN` must be exactly the visible address, with the port and without a slash at the end. The default is `https://localhost:8443`. The application itself does not publish a host port. Caddy publishes HTTP 8080 and HTTPS 8443. Use the HTTPS address directly.

For a public DNS target, set these values:

- `CADDY_ADDRESS=https://portal.example.com`
- `CADDY_SERVER_NAME=portal.example.com`
- `SITE_ORIGIN=https://portal.example.com`
- The ports 80/443.
- `CADDY_TLS=admin@example.com`

DNS and ACME access must work. The [Caddy documentation](https://caddyserver.com/docs/caddyfile/concepts) describes the automatic certificates and the reverse proxy of Caddy. `CADDY_SERVER_NAME` sets [default_sni](https://caddyserver.com/docs/caddyfile/options#default-sni). Thus, clients without SNI also get the correct certificate for an IP address.

`smoke` makes its own short-lived Docker volume and applies the migrations. It starts the container and checks the two health endpoints and UID 1000. Then it restarts the container and checks the migration again. After this, it removes only this test volume and this test container. It opens no production ports.

The web start itself does not apply schema changes. `up --migrate` is the explicit maintenance step: it stops the app, migrates the database and then starts Compose.

`compose.yaml` uses the persistent volumes `serverdesk_db-data`, `serverdesk_app-data`, `serverdesk_caddy-data`, `serverdesk_caddy-config` and `serverdesk_portal-ca` (only the public root certificate of the local Caddy CA). `serverdesk_db-data` holds the PostgreSQL data of the `db` service. `serverdesk_app-data` holds the objects and the backups. You can also use a NAS bind mount for `serverdesk_app-data`. UID/GID 1000 must own its data directory. Keep the PostgreSQL data on a local file system, not on SMB or NFS.

The `db` service is on the internal network `serverdesk_database`. This network has no outbound access. Only `app` joins it. Thus, the proxy cannot connect to the database. After you update `compose.yaml`, `docker compose up -d` makes the containers again on the new networks. The data volumes stay.

### Outbound hosts of the portal

The portal itself needs outbound HTTPS only for the optional functions below. Without these hosts, the other functions continue to work.

| Function | Hosts |
|---|---|
| [GPU driver updates](gpu-driver-updates.md): NVIDIA lookup | `www.nvidia.com`, `gfwsl.geforce.com`, `us.download.nvidia.com`, `international.download.nvidia.com` |
| [GPU driver updates](gpu-driver-updates.md): AMD lookup | `www.amd.com`, `drivers.amd.com` |
| [Notifications](notifications.md) | The SMTP servers and HTTPS targets of your channels |
| [Vulnerability check](software-vulnerabilities.md) | `services.nvd.nist.gov`, and `vulnerability.circl.lu` with the CVE.org source |
| [AI assistant](ai-assistant.md) | `api.anthropic.com` or `api.openai.com`, the host of the provider of each key |

The devices download a GPU driver package themselves from `us.download.nvidia.com`, `international.download.nvidia.com` or `drivers.amd.com`.

Caddy redirects HTTP 8080 explicitly to `SITE_ORIGIN`, with the external HTTPS port 8443 and the request path. For this, the configuration disables the automatic Caddy redirect, because it does not know the different host port. The host ports stay 8080/8443. Only the proxy container uses 80/443 internally.

`compose.yaml` does not build an image. It starts the image from `SERVERDESK_IMAGE`. If this value is empty, it uses `docker.io/lostindreamz/nodiverna:latest`. For a locally built image, first run `image --image serverdesk:local` and then `up --image serverdesk:local`. After a successful start, `up --image <tag>` saves the tag in the file `.env.deployment`, which is not secret. The pipeline runner loads this file itself for later commands.

Direct Compose commands then need **both** files: `--env-file .env.runtime --env-file .env.deployment`. An explicit `--env-file` prevents the automatic load of a usual `.env` file. The secrets stay in `.env.runtime`. The Caddy configuration is inline in `compose.yaml` and is the same as `deploy/Caddyfile`. `compose.dev.yaml` continues to mount `deploy/Caddyfile` directly.

## Run with Docker Compose

For your own server or a NAS, you need only Docker with Compose, the file `compose.yaml` and an environment file. The image `docker.io/lostindreamz/nodiverna` comes ready from Docker Hub, at this time only for `linux/amd64`. You do not need a checkout, a build or Node.js on the host. The Caddy configuration is inline in `compose.yaml`.

1. Download `compose.yaml` and the template for the environment file into an empty directory:

   ```sh
   mkdir nodiverna && cd nodiverna
   curl -fsSLO https://raw.githubusercontent.com/LostInDreamZ/nodiverna/main/ServerDesk/compose.yaml
   curl -fsSLO https://raw.githubusercontent.com/LostInDreamZ/nodiverna/main/ServerDesk/deploy/runtime.env.example
   ```

2. Make the file `.env.runtime` and generate the secrets. The command uses the Node.js in the image:

   ```sh
   grep -v -E '^(SESSION_SECRET|PASSWORD_PEPPER|AGENT_JOB_SIGNING_KEY|DATABASE_PASSWORD)=' runtime.env.example > .env.runtime
   docker run --rm --entrypoint node docker.io/lostindreamz/nodiverna:latest -e "const c=require('crypto'),r=()=>c.randomBytes(48).toString('base64url');console.log('SESSION_SECRET='+r()+'\nPASSWORD_PEPPER='+r()+'\nDATABASE_PASSWORD='+c.randomBytes(24).toString('hex')+'\nAGENT_JOB_SIGNING_KEY='+c.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))" >> .env.runtime
   chmod 600 .env.runtime
   ```

   Then write the address into `.env.runtime`. `SITE_ORIGIN` is exactly the address in the browser, with the port and without a slash at the end. For a device in the LAN at `192.168.1.10`, set these values: `SITE_ORIGIN=https://192.168.1.10:8443`, `CADDY_ADDRESS=https://192.168.1.10` and `CADDY_SERVER_NAME=192.168.1.10`. For a public DNS name, use the values from [Production image and local Compose installation](#production-image-and-local-compose-installation).

3. Download the image:

   ```sh
   docker compose --env-file .env.runtime pull
   ```

4. Migrate the database:

   ```sh
   docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs migrate
   ```

5. Start the portal:

   ```sh
   docker compose --env-file .env.runtime up -d
   ```

6. Make the first owner. Open the invitation link from the output within 24 hours:

   ```sh
   docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs bootstrap-owner --username admin --display-name Administrator
   ```

7. Set the image tag. Without a value, `compose.yaml` uses the tag `latest`. For a fixed version, add the line `SERVERDESK_IMAGE=docker.io/lostindreamz/nodiverna:<version>` to `.env.runtime`, for example `0.1.1`. The [Releases](https://github.com/LostInDreamZ/nodiverna/releases) page shows the versions. The tag `<major>.<minor>` follows the patch releases of this version. The tag `latest` follows only stable releases.

8. Update the portal. First, make a backup as [Backup before updates](#backup-before-updates) tells. Then run these commands. They download the new image, migrate the database and start the portal again:

   ```sh
   docker compose --env-file .env.runtime pull
   docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs migrate
   docker compose --env-file .env.runtime up -d
   ```

9. Use Docker Compose 2.23.1 or later (`docker compose version`). Only from this version, Compose understands `configs.content`. `compose.yaml` uses it to supply the Caddy configuration.

The project name, the ports and the volumes are the same as in the local Compose installation: `serverdesk_app-data`, `serverdesk_caddy-data`, `serverdesk_caddy-config` and `serverdesk_portal-ca`, HTTP 8080 and HTTPS 8443. An installation that exists keeps its data when you replace `compose.yaml` in the same directory. Instead of a named volume, you can also use a bind mount. UID/GID 1000 must own its data directory.

Agent releases: The image does not contain an agent. A new installation imports the newest agent release from GitHub about one minute after its first start. Without access to GitHub, import a release folder with `import-release` (refer to [Agent releases from GitHub](#agent-releases-from-github)). After the import, the installers and the agent download use this release on every origin.

### HTTPS with the local Caddy CA

Without a public DNS name, Caddy issues the certificate with its own local CA. Windows devices do not trust this CA. The Windows agent runs as a service and needs trust in the local computer store. With a public HTTPS certificate that is already trusted, you do not need the steps in this section.

**Automatic embedding in the install scripts:** The service `ca-export` in `compose.yaml` copies only the **public** root certificate of the local CA into the volume `serverdesk_portal-ca`. It never reads the private CA key. The `app` service mounts this volume read-only and reads the file in `PORTAL_CA_FILE`. Each install script from the portal then contains this root certificate. This applies to the personal install script and to the installers for customers. With `CADDY_TLS` set to an email address (public certificate), `ca-export` removes the copy, and the scripts contain no root certificate.

An installation that exists gets this function only with the new `compose.yaml`. Replace the file in the same directory and start `docker compose --env-file .env.runtime up -d`. Within one minute, the page **Devices** › **Add device** shows the card **Portal certificate** with the SHA-256 fingerprint.

**Trust scope:** The local Caddy root certificate has no name constraints. After the import, the computer trusts every certificate from this CA for every name, not only for the portal. Import the root certificate only on devices that you manage. Protect the volume `serverdesk_caddy-data`, because it holds the private CA key.

**On the device:** The install script first does a TLS handshake with the portal and sends no data before the certificate check. The certificate must contain the portal address, for an IP address as an IP address entry, or the script stops and imports nothing. Thus `CADDY_ADDRESS` must use the same host as `SITE_ORIGIN`. If Windows trusts the portal certificate, the script continues without a message. If not, the script makes sure that the certificate comes from the embedded root certificate. Then it shows the name and the SHA-256 fingerprint of the root certificate and asks:

1. Compare the fingerprint with the value in **Devices** › **Add device** › **Portal certificate** in the portal.
2. If the values are equal, select **Import**. The script adds the root certificate to `Cert:\LocalMachine\Root` and continues.
3. If the values are different, select **Cancel**. The script stops and makes no changes.

If the certificate does not come from the embedded root certificate, the script stops and imports nothing. For unattended installations, start the script with `-TrustPortalCertificate`. The script then shows the same name and fingerprint and imports the root certificate without a question. Without this switch, a non-interactive session stops before the import.

**Manual export:** If you cannot use the install scripts, export the **public** root certificate by hand:

```sh
docker compose --env-file .env.runtime cp proxy:/data/caddy/pki/authorities/local/root.crt ./serverdesk-root.crt
```

Import this certificate as a trusted CA on your computer and on test devices. On Windows, the certificate store of the current user is sufficient for the browser. For the agent, import it into the local computer store. Do not export the private CA key. Use MFA and agent registrations only after a successful certificate check.

**Remove the root certificate:** Open `certlm.msc` and go to **Trusted Root Certification Authorities** › **Certificates**. Delete the certificate with the name from the portal. Or, in a PowerShell as administrator, find the thumbprint and remove the certificate:

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like '*Caddy Local Authority*'
Remove-Item Cert:\LocalMachine\Root\<thumbprint>
```

Remove the root certificate from each device that no longer uses the portal. While it is in the store, the computer trusts every certificate from this CA for every name, because the root has no name constraints. After the removal, the agent on this device cannot connect to the portal. The next install script offers the import again.

### MFA at an IP address

At an IP address, use TOTP for MFA. When a user redeems the invitation there, ServerDesk offers only the authenticator app. Passkeys need a matching DNS name as the RP ID, because an IP address does not meet the WebAuthn domain requirement ([W3C WebAuthn](https://www.w3.org/TR/webauthn-3/#rp-id)). For passkeys, configure an internal DNS name and a trusted certificate. Then adapt `SITE_ORIGIN` and Caddy. Generate the public release signature for this origin again.

### Protection against sign-in attempts

ServerDesk counts only failed sign-ins. A successful sign-in does not increase a counter. Four limits apply, each in 10 minutes:

- 10 failed attempts for each account and client address.
- 40 failed attempts for each client address.
- 200 failed attempts when no trusted client address is known.
- 100 failed attempts for each account over all addresses together.

When a limit is reached, the sign-in responds with 429 until the end of the window, also with the correct password. Only attempts that no address limit rejected count toward the account limit over all addresses.

ServerDesk groups IPv6 addresses by their /64 prefix, because a connection usually gets a full /64 network. Thus, all addresses of a /64 share the limits for each address and for each account and address. IPv4 addresses count individually.

The client address comes only through `TRUSTED_CLIENT_IP_HEADER`. The NAS Caddy configuration (`deploy/Caddyfile`, `deploy/runtime.env.example`) sets this header. Then a foreign client locks only its own address. An attacker who changes between many addresses (botnet, many IPv6 networks) meets the limit of 100 failed attempts for each account and the MFA. When an attacker reaches this limit, ServerDesk locks the account for 10 minutes for all addresses.

Without `TRUSTED_CLIENT_IP_HEADER`, all clients share one address. This is the remaining compromise. Then anyone can still lock a known account for 10 minutes with 10 failed attempts. Also, 200 failed attempts lock all sign-ins for 10 minutes.

Each lockout shows in the access log as an entry `auth.lockout` from the actor `System`. ServerDesk writes one entry for each limit and 10-minute window. The entry names the affected limit and the client address. IPv6 addresses show as /64, and without a trusted address the entry shows `unknown-ingress`. For limits that apply to an account, the entry also names the user ID.

For user names that belong to no account, ServerDesk writes only the entry for the address. Passwords and typed user names never go into the log. Sign-in, the redemption of invitations and password changes count in separate account limits. But they share the limit for each address.

### Backup before updates

`migrate` writes a database backup before the first pending migration. Refer to [Backups](#backups). If the migration fails, the data volume stays. Keep the previous image tag for a rollback. After a schema change, an old image is not automatically compatible with the new schema.

## Azure Container Apps

`node deploy/azure.mjs` updates a prepared container app to a tested image. Use any tested tag from Docker Hub (`docker.io/lostindreamz/nodiverna:<version>`), or a copy of it in a private registry such as Azure Container Registry (ACR).

For the company environment, first provision these resources in the applicable subscription:

- Pull access for the container app to the registry of the image. For a private registry such as ACR, give the app pull access to that registry.
- An Azure Container Apps environment and a container app. The container app has one app container, the revision mode `Single`, HTTPS ingress on port 3000 and the HTTP probes below.
- Azure Database for PostgreSQL Flexible Server, version 17, with a database `serverdesk` and a user `serverdesk`. The app connects with TLS: set `sslmode=require` or `sslmode=verify-full` in `DATABASE_URL`. Give the server private network access from the Container Apps environment, or allow only the outbound addresses of the environment in the server firewall.
- An Azure Storage account with a blob container that already exists. Give the managed identity of the app the role `Storage Blob Data Contributor` on the applicable container or account.
- Runtime secrets for `SESSION_SECRET`, `PASSWORD_PEPPER`, `AGENT_JOB_SIGNING_KEY` and `DATABASE_PASSWORD`. Add them as Container Apps secret references. Use the same secrets on all replicas. The database URL and the account URL contain no credentials.

On purpose, `deploy/azure.mjs` does not make this infrastructure with invented subscription, network or resource names. The rollout updates the prepared app. Before the change, it checks the external database, the Azure Storage configuration, the secret references, the ingress and the probes.

The relevant app environment:

```dotenv
NODE_ENV=production
SITE_ORIGIN=https://portal.example.com
SESSION_SECRET=secretref:<session-secret-name>
PASSWORD_PEPPER=secretref:<pepper-secret-name>
AGENT_JOB_SIGNING_KEY=secretref:<job-signing-secret-name>
DATABASE_URL=postgres://serverdesk@<server>.postgres.database.azure.com:5432/serverdesk?sslmode=require
DATABASE_PASSWORD=secretref:<database-password-secret-name>
OBJECT_STORAGE_DRIVER=azure
AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net
AZURE_STORAGE_CONTAINER=serverdesk
```

Here, `secretref:` is Azure CLI configuration notation. The application receives the resolved value as an environment variable. If possible, use blob access through a managed identity. For other environments, the adapter also supports `AZURE_STORAGE_CONNECTION_STRING`. Put this value in a secret reference too. With a user-assigned managed identity, `AZURE_CLIENT_ID` can be necessary to select the identity.

Azure Container Apps supplies TLS and the proxy, so you do not need the NAS Caddy there. Set `TRUSTED_CLIENT_IP_HEADER` only if the backend is privately reachable and the ingress reliably overwrites this header. Without this guarantee of trust, do not use an IP header field that the client sends. Without the header, the shared limits from [Protection against sign-in attempts](#protection-against-sign-in-attempts) apply.

Configure these probes in the app container ([Microsoft documentation](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)):

```yaml
probes:
  - type: Startup
    httpGet: {path: /api/health/live, port: 3000}
    initialDelaySeconds: 2
    periodSeconds: 5
    timeoutSeconds: 4
    failureThreshold: 24
  - type: Liveness
    httpGet: {path: /api/health/live, port: 3000}
    periodSeconds: 15
    timeoutSeconds: 4
    failureThreshold: 4
  - type: Readiness
    httpGet: {path: /api/health/ready, port: 3000}
    periodSeconds: 10
    timeoutSeconds: 4
    failureThreshold: 3
```

`live` checks the running process. `ready` also checks the database and the object storage, and it writes no test objects. `deploy/azure.mjs` sets a minimum of one running replica, a default maximum of three (`--max-replicas`), and an HTTP scaling rule. The selection and the limits must match the agent traffic and the measured load. [Container Apps scaling](https://learn.microsoft.com/en-us/azure/container-apps/tutorial-scaling) describes the rules.

For migrations, prepare a **separate manual Container Apps job** with these settings:

- The same database, storage and origin context as the web app.
- The same session and pepper values.
- One container.
- `command: [node]` and `args: [scripts/selfhost.mjs, migrate]`.

With `--migration-job`, the rollout sets the image of this job to the tested release. It limits the parallelism and the completion count to 1 and the retries to 0. It checks for running executions, starts exactly one execution and waits for its success. After this, it updates the web app. For more information about jobs, refer to the [Microsoft documentation](https://learn.microsoft.com/en-us/azure/container-apps/jobs).

For incompatible schema changes, plan a maintenance window and a backup first. During the job, the previous app version can continue to process requests. Make the first owner invitation separately in an administrative one-time run. Transfer the invitation confidentially. Do not keep passwords or invitation links in scripts or command histories.

On Linux or WSL, with the Azure CLI signed in, the rollout command is:

```sh
node deploy/azure.mjs --resource-group <group> --app <app> --image docker.io/lostindreamz/nodiverna:<version> --max-replicas 3
# Include the schema change explicitly:
node deploy/azure.mjs --resource-group <group> --app <app> --image <registry>.azurecr.io/serverdesk:<tag> --migration-job <job>
```

Many web replicas share the database and the blob storage. For Azure Container Apps, the local `/data` variant does not replace persistent external state, also with a single replica. Each process has one connection pool with `DATABASE_POOL_MAX` connections (default 10). Keep the sum of all pools below the connection limit of the server.

Azure Database for PostgreSQL makes automatic backups and supports point-in-time restore. For this reason, the migration job can run `migrate --skip-backup`. Set the backup retention of the server to the time that you need.

## Maintenance

The portal runs the maintenance itself, every day. The default time is 03:00 UTC. You do not configure a container, a cron job or a scheduled job for it. The maintenance removes old audit rows, completed jobs with their output, old software changes and expired file transfers. It cleans the transfers of all devices, also of devices that do not poll any more.

At the end, it sends the usage report and checks GitHub for new agent releases. This version sends no usage report, because the usage data function is off.

The maintenance also deletes the script of each completed assistant script job after 7 days ([AI assistant](ai-assistant.md#run-a-command)). The job and its output stay until the job retention deletes them.

**The Data retention page:** Owners find the page **Data retention** under **Settings**. The page starts with a row of three figures:

- **Database size**: the size of the database, and the part of it that the areas in the table below use.
- **File transfer storage**: the object storage of the file transfers that the maintenance did not clear yet.
- **Deleted in the last run**: the rows that the last finished run deleted, and the cleared transfers.

A figure that the portal cannot read does not show. Then the page has two cards:

- **Daily cleanup**: the status of the last run, its start, the next run and the daily time. After a failed run, the card also shows the last success and the text of the stored reason. The details are in the server log of the portal process. **Run now** starts a run immediately. **Recent runs** opens the last 20 runs of all portal instances, with the duration, the trigger and the result of each run.
- **Retention by area**: one row for each area that the maintenance cleans. A row shows the retention, where the retention is set, the size, the number of entries and the result of the last run.

The sizes and the entries are estimates. They come from the statistics of PostgreSQL (`pg_total_relation_size`, `pg_stat_user_tables`), so the page does not count the rows of large tables. The file transfer storage is the sum of the chunk sizes in `transfer_chunks`.

**Change retention…** at the top of the page opens a panel with the audit retention and the job retention in days. **Change schedule…** in the card **Daily cleanup** opens a panel with the daily time and the time zone. A change applies from the next run, without a restart. When the audit retention or the job retention gets shorter, you must confirm your identity with MFA again before the save. A change of the daily time or the time zone, or a longer retention, needs no new MFA confirmation. The portal audit then gets the entry `Maintenance settings changed` with the old and the new value of each setting, for example `Audit 30 → 10 days` and `daily run 03:00 UTC → 04:30 Europe/Berlin`.

The retention is in days, as whole numbers from 1 to 3650. Job output (diagnostics, file, storage and runbook results) has the same retention as the jobs. The agent channel does not delete it itself any more.

**Start values:** `AUDIT_RETENTION_DAYS` and `JOB_RETENTION_DAYS` are only start values. For each value, this order applies:

1. The value that an owner saved on the page.
2. The environment variable of the portal process. An empty variable counts as not set.
3. 30 days.

When a saved value exists, the variable has no effect. The page shows when a value comes from a variable. Without a saved value, an invalid variable makes each run fail, and the page shows the field as empty, with an error. Until you save a valid retention, you cannot save the schedule.

**Lock across replicas:** Each portal process has one scheduler. It checks every minute if a run is due. A run first takes a lock in the table `maintenance_lock`, so only one run is active across all instances and replicas. The lock is a lease of 10 minutes.

The active run extends the lease every 60 seconds and releases it at the end. If a process stops during a run, its lease expires. The next run then takes the lock and records the stopped run as failed. If another instance takes the lock during a run, the run stops before its next area and is recorded as failed.

**When a run starts:** A run is due when no run started since the last daily time. Thus a new installation runs about 30 seconds after the portal starts.

A daily time that passed while the portal was stopped runs at the next start. A run starts only when all migrations are applied. Until then, the scheduler writes one log line and waits.

**Automatic continuation:** The maintenance deletes in small batches and limits the work for each run. If an area reports `more: true`, work remains. Then the scheduler starts a next run with the trigger `continuation`. This run starts at least one minute after the previous run ended. While a continuation waits, the page shows its start as the next run.

A maximum of 24 runs occur for each daily time, and also after **Run now**. A failed run does not continue. The command line does not start a continuation.

The maintenance never deletes waiting and running jobs because of their age. It does not touch active transfers.

**Audit entries:** The maintenance writes three entries into the portal audit: `Maintenance settings changed` (refer to **The Data retention page** above), `Maintenance run started` and `Audit retention applied`. **Run now** writes `Maintenance run started`, with the account that started the run as the actor. The entry contains the trigger and the run ID, for example `Run now, trigger manual, run 42`. The run row and this entry are written together. Scheduled runs, continuations and the command line write no such entry.

Each run that deletes audit rows records this in the entry `Audit retention applied` from the actor `System`. It contains the cutoff date, the retention and the number of deleted rows, for example `Cutoff 2026-09-16T12:00:00.000Z, retention 30 days, deleted rows: 42`. The entry itself is subject to the audit retention. Older entries keep the German action `Audit-Aufbewahrung angewendet` and their German details. The maintenance does not change them.

If the run cannot write the entry, the last audit deletion of the run does not occur. The run then fails and does not clean jobs and transfers.

**Retention for each customer:** A customer can have its own audit retention on the page **Customers**. This retention applies to the device logs and customer entries of this customer. It also applies when the customer is deactivated. The customer value has priority over the instance retention of the page **Data retention**. The instance retention stays the default for rows without a customer and for customers without their own value. On the page **Data retention**, the row **Customer audit entries** shows the shortest and the longest customer retention, with a link to the page **Customers**.

The instance retention also applies to the audit rows of a deleted customer. These rows keep its ID, and `removed_customers` names it.

For this, a run has passes: one instance pass, and one separate pass for each customer with its own retention. The instance pass has one segment for each customer without its own retention and for each deleted customer. Each pass that deletes rows writes its own entry `Audit retention applied` with its cutoff date and its retention. The entry of a customer pass carries this customer and shows in the audit as `Customer: {customerName}`. The result gives the instance pass under `audit` and the customer passes under `customerAudit` as a list `{customerId, auditDays, deleted, more}`.

**Usage data:** This version sends no usage report. The function is off, and the result is `{"status":"disabled"}`, also with `LICENSE_SERVER_URL` set.

When the function is on, the portal sends the report from [`usage-data.md`](usage-data.md) to `LICENSE_SERVER_URL` at the end of each run. The report contains the instance ID, the version and the device count. The portal sends it a maximum of one time in 20 hours, and only when an owner agreed in the portal. With many replicas, only one sends it. Without `LICENSE_SERVER_URL`, nothing occurs, also no network access.

The result has the key `usageReport`, for example `{"status":"sent"}` or `{"status":"failed","error":"http-503"}`. A report that the portal did not send never changes the status of the run.

**Agent releases:** Then the run checks GitHub for new agent releases (refer to [Agent releases from GitHub](#agent-releases-from-github)). The result ends with the key `releaseImport`, for example `{"status":"ok","imported":1,"present":2,"failed":0,"removedChunks":0}`. While another check runs, the value is `{"status":"skipped","removedChunks":0}`. A failed check never changes the status of the run.

**Log and notice:** Each run writes one row into the table `maintenance_runs`. The row contains the start, the end, the status (`running`, `succeeded`, `failed`), the trigger, the result JSON and, for a failed run, a reason. The trigger is `schedule`, `continuation`, `manual` (**Run now**, with the account) or `cli` (the command line). A run with transfers that the file storage could not clean counts as failed.

The reason of a failed run is a fixed key, for example `serverMessage.maintenance.lockLost`. The page shows the text of the key. The details of the error are in the server log of the portal process, in the line `ServerDesk: Maintenance run <id> failed: <message>`. The command line also writes the error to stderr.

If the last successful run is more than 48 hours ago, or if there was no run, owners see a notice in the console. The notice is `The daily cleanup is overdue.` or `The daily cleanup has not run yet.` Its link opens the page **Settings → Data retention**. The notice disappears after the next successful run.

Only the maintenance writes rows into `maintenance_runs`. The other offline commands that change data write an entry into the portal audit:

- `bootstrap-owner`: `auth.owner.bootstrap` from the actor `offline-bootstrap`, with the ID of the new owner.
- `rewrap-secrets`: `Secrets rewrapped` from the actor `System`, with the kid and the counters (refer to [Change the session secret](#change-the-session-secret)).
- `reset-totp`: `TOTP authenticators reset` from the actor `System`, with the counters.
- `import-release`: `Agent release imported from a folder` from the actor `System`, with the version.

**Switch off the scheduler:** `MAINTENANCE_SCHEDULER=off` in the environment of a portal process stops its scheduler. The same scheduler also runs the alarm check once a minute (see [Alert rules](alert-rules.md)), so this setting stops that check too. Use it only for support and tests. **Run now** stays available.

**Command line:** For support and tests, you can start one run with this command:

```sh
node --env-file=.env.local scripts/selfhost.mjs maintenance [--audit-days 30] [--job-days 30] [--software-days 365] [--alert-days 90]
pnpm db:maintenance
```

In Compose, use `docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs maintenance`. For each value, the command uses this order: the flag, the saved value, the environment variable, 30 days.

A flag applies only to this run, and the command never saves it. The command takes the same lock as the portal and writes the trigger `cli`. If another run holds the lock, the command stops with exit code 1 and writes no row. Exit code 1 also means an error, or transfers that the file storage could not clean. The JSON output gives the result for each area.

The software change history of the devices (installed, updated and removed programs) has its own retention: `--software-days` or `SOFTWARE_CHANGE_RETENTION_DAYS`, from 1 to 3650 days. Without a value, it is 365 days.

The page **Data retention** shows this value and the variable that sets it, but you cannot change it on the page. The scheduled run, **Run now** and the command line all use it. The result gives the deleted rows under `softwareChanges`. The current software list of a device stays until the agent sends a new list or the device is removed.

Closed alarms have their own retention too: `--alert-days` or `ALERT_RETENTION_DAYS`, from 1 to 3650 days. Without a value, it is 90 days. Open and pending alarms always stay. The page **Data retention** shows this value, but you cannot change it on the page. The result gives the deleted rows under `alerts`.

The notification log uses the same alarm retention. Events that wait to be sent and messages that are not finished stay. The result gives the deleted events under `notifications`. Refer to [Notifications](notifications.md).

**Private notification targets:** notification channels refuse private network addresses by default. Set `NOTIFY_ALLOW_PRIVATE_TARGETS=true` in the environment of the portal to allow them, for example for an internal SMTP relay. Loopback, link-local and cloud metadata addresses stay refused.

## Agent releases from GitHub

The CI publishes each agent release in the repository `nodiverna/nodiverna` as a GitHub release `agent-vX.Y.Z`. The portal imports these releases itself. You do not copy binaries, and you do not need the private key of the publisher. The source is fixed. No setting or variable changes it.

The image does not contain an agent. The installers, `/Agent-v3-release.json` and the agent download on the page **Devices → Add device** use the newest imported release. Until the first import, they answer that no agent release is available. Each portal process keeps the answer of `/Agent-v3-release.json` for 30 seconds. Thus `/Agent-v3-release.json` shows a new import within about 30 seconds. The variables `BUILTIN_RELEASE_SIGNATURE`, `RELEASE_SIGNING_KEY` and `RELEASE_SIGNING_KEY_FILE` of earlier versions are no longer used, and you can remove them.

**When the portal checks:** On a new installation, the first check starts by itself about one minute after the first start. Each maintenance run checks the source one time, after the retention work (refer to [Maintenance](#maintenance)).

On the page **Settings → Agent releases**, an Owner can select **Check now** at the top of the page. A check then starts within about one minute, and the audit gets the entry `Agent release check requested`. While a check waits or runs, **Check now** changes nothing and writes no audit entry. `MAINTENANCE_SCHEDULER=off` stops the automatic checks of that portal process.

**What the portal checks:** A check reads the list of releases from `api.github.com`. It uses only published releases with a tag `agent-vX.Y.Z` and only the three highest versions. For each release, the portal needs these five files: the ZIP, the EXE, the record, the manifest and the signature. The portal then does these checks before it adds the release:

- The size of each file is in its limit.
- The signature of the manifest matches the publisher key that this repository pins (`lib/release-publisher.json`).
- The manifest has the path form and the expected file names.
- The SHA-256 and the size of the ZIP, the EXE and each 20 MiB part match the signed manifest.
- No other release in the catalog has the same version, and no other file uses the same path.

A release that fails a check does not go into the catalog. The page shows the reason in the table **Imports**. The daily check does not download a release again after a permanent failure until its files change. **Check now** tries every failed release again.

**Deactivate or delete a release:** Each row of the table **Agent releases** has a menu. **Show details** shows the facts, the changelog and the SHA-256 of the release. **Deactivate…** stops new updates with the release, and **Delete…** removes it from the catalog. Both ask for a confirmation first. To deactivate or delete the latest release, import a newer release first.

**Access to GitHub:** The repository `nodiverna/nodiverna` is public. The portal reads it without sign-in, and you do not configure a token. GitHub limits the requests without sign-in to 60 per hour for each IP address. A check uses one to three requests for the list of releases and one request for each file that it downloads. The list has a maximum of three pages of 100 releases, so dev builds do not hide a release. A first import of several releases can come near this limit.

If GitHub limits the requests, the check stops and sends no more requests. When the list is limited, the page shows the reason in a notice above the facts. When a file download is limited, the table **Imports** shows the reason for that release. It also shows it for each other release that the check did not download. The limit resets within an hour. The next check tries these releases again, also the daily check.

**Object storage:** The portal keeps the files of an imported release in its object storage (`OBJECT_STORAGE_DRIVER`), as 20 MiB chunks under `agent-releases/sha256/`. Agents download them from the portal under `/downloads/`. Agents never connect to GitHub. Include the object storage in your backup. Without these objects, the portal cannot give the files of an imported release to the agents.

The catalog shows only releases whose files the portal has. After the imports, each check deletes the chunks that no release uses any more, for example the chunks of a deleted release. It keeps a chunk that is less than 24 hours old, so that a running import keeps its files. The result of the maintenance run shows the number of deleted chunks as `removedChunks`. Before an import uses a stored chunk again, it reads the chunk and compares its SHA-256. If the bytes are different, the import writes the chunk again.

**No rollout:** An import only adds the release to the catalog, with the audit entry `Agent release imported from GitHub`. It never updates a device. You start an update in the device overview, as before. Only agents from 4.12.0 accept an imported release, because it has the path form.

**Plugin releases:** The same check also imports the agent plugins, from the GitHub releases with a tag `plugin-<name>-vX.Y.Z`. Each plugin release has four files: the EXE, the record, the manifest and the signature. The portal does the same checks and keeps the EXE as chunks in the same object storage. The chunk cleanup keeps the chunks of each plugin release. The page **Settings → Extensions** shows them, refer to [Extensions](extensions.md).

An import never installs a plugin. For the rollout, refer to [Agent plugins](agent-plugins.md#rollout-with-pilot-devices).

**Dev builds:** The CI can also publish a test build from the branch `dev`. It is a GitHub pre-release with a tag `agent-vX.Y.Z-dev.<sha7>` or `plugin-<name>-vX.Y.Z-dev.<sha7>`. `<sha7>` is the start of the commit. By default, the portal does not import dev builds.

On the page **Settings → Agent releases**, an Owner can turn on **Import dev builds**. The audit gets the entry `Agent dev builds turned on` or `Agent dev builds turned off`. While the setting is on, these things change:

- Each check also imports the three newest dev builds of the agent and of each plugin, with the same checks.
- The update notice of a device and the agent updates of the fleet also offer a dev build. A dev build has the tag **Dev build**.
- You can deploy a dev build of the agent and roll out a dev build of an extension.

These things do not change:

- The latest release is never a dev build. New installations, `/Agent-v3-release.json` and the agent download always use the latest release.
- An install or a repair of an extension never uses a dev build.
- A dev build ranks below the release of its version. A device with `4.21.5` does not get `4.21.5-dev.abc1234`. A device with the dev build gets `4.21.5` when it is imported.

When you turn off the setting, the check does not import new dev builds, and devices do not get dev builds as an offer. Imported dev builds stay in the catalog. To stop an update that you planned, deactivate the dev build. The command `import-release` imports a folder with a dev build also when the setting is off.

**Installations without access to GitHub:** Copy the five files of a release into one folder. Then import the folder with this command:

```sh
node --env-file=.env.local scripts/selfhost.mjs import-release <dir>
```

In Compose, mount the folder into the container and run `docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs import-release /path/in/container`. The command needs all migrations. It does the same checks without network access and writes the audit entry `Agent release imported from a folder`. The JSON output is `{version, releaseId, status}`. For a folder with the four files of a plugin release, the command imports the plugin, and the output also has `kind` and `name`. If a file is missing or a check fails, the command stops with exit code 1 and an English message.

## Outbound connections

These portal functions open outbound connections. Allow them in your firewall if you use them:

- The usage report to `LICENSE_SERVER_URL`, only after an owner agreed ([usage-data.md](usage-data.md)). This version sends no usage report, because the function is off.
- The notification channels to their SMTP, Teams or webhook targets ([notifications.md](notifications.md)).
- The vulnerability check to `services.nvd.nist.gov` on port 443, only after an owner turned it on ([software-vulnerabilities.md](software-vulnerabilities.md)). With `MAINTENANCE_SCHEDULER=off`, the check does not run.
- The CVE.org source of the vulnerability check to `vulnerability.circl.lu` on port 443, only after an owner turned on the CVE.org source ([software-vulnerabilities.md](software-vulnerabilities.md#source)).
- The AI assistant to `api.anthropic.com` or `api.openai.com` on port 443, only after an owner or a user saved an API key ([ai-assistant.md](ai-assistant.md)). The `app` container needs outbound HTTPS to these hosts for this function.
- The check for agent releases to `api.github.com` and `*.githubusercontent.com` on port 443, during each maintenance run and after **Check now** (refer to [Agent releases from GitHub](#agent-releases-from-github)).

## Change the session secret

`SESSION_SECRET` encrypts the stored TOTP secrets of the authenticator apps. Each encrypted value has the identifier (kid) of the key that encrypted it. With this procedure, you can change the secret, and MFA users do not lose access:

1. Write the new value in `SESSION_SECRET`. Write the old value in `SESSION_SECRET_PREVIOUS`. Separate many old values with commas. Each value needs a minimum of 32 UTF-8 bytes.
2. Restart the portal. It encrypts new values with the new secret. It continues to read old values with `SESSION_SECRET_PREVIOUS`.
3. Encrypt all stored values again with the new secret:

   ```sh
   node --env-file=.env.local scripts/selfhost.mjs rewrap-secrets
   ```

   In Compose, run `docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs rewrap-secrets`.
4. If the JSON output shows `"failed": 0`, remove `SESSION_SECRET_PREVIOUS`. If you forget this step, the Owner sees the notice **The old session secret is still set.** in the console. At each start, the portal also writes a warning to its log. The notice and the warning contain no secret.
5. Restart the portal again.

The command also encrypts these values again: the notification channel secrets and the NVD API key. It also encrypts the API keys of the AI assistant again.

The command runs only when all migrations are applied. It can run while the portal is online. It changes each row separately, and only if the row did not change since the command read it. A sign-in or an authenticator change can change the same row at the same time. Then this action fails one time and is successful at the next attempt. The output `{keyId, checked, rewrapped, unchanged, failed}` contains only the identifier of the current key and counters, no secrets.

If `failed` is more than 0, an old secret is missing in `SESSION_SECRET_PREVIOUS`. The command then stops with exit code 1 and does not change these values. Add the secret and start the command again. A second run shows `"rewrapped": 0`.

The command also encrypts the notification channel secrets and the NVD API key again.

`rewrap-secrets` encrypts the same TOTP secrets again. It does not change them, so the authenticator apps of the users continue to work. Each run writes an audit entry **Stored secrets encrypted with a new key** with the actor **System**. The entry contains the kid and the counters.

### After a leak of the session secret

Did `SESSION_SECRET` leak together with a copy of the database? Then a rotation alone does not protect the TOTP secrets. A person with the old secret and the copy can calculate the codes of each authenticator app. Thus all users must enroll their authenticator apps again:

1. Change the secret with steps 1 to 5 above.
2. Delete all stored TOTP secrets:

   ```sh
   node --env-file=.env.local scripts/selfhost.mjs reset-totp --confirm
   ```

   In Compose, run `docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs reset-totp --confirm`.
3. Tell the users to sign in and set up MFA again.
4. If a person can also know the passwords, give each user a new password link. On the page **Accounts**, use the key button of the user (**Create a new password link?**, API action `reset-link`).

`reset-totp` does these steps in one transaction:

- It deletes all authenticator apps and all pending app setups. The users lose their apps.
- Passkeys stay. A user with a passkey keeps MFA and the recovery codes, and signs in with the passkey.
- A user without a passkey loses the MFA setup. At the next sign-in, this user enrolls MFA again.
- All MFA sessions and remembered browsers of these users end.
- A user who then has no MFA loses the automation approvals and the desired-state schedules. This is the same as when a user disables MFA.
- It writes one audit entry **TOTP authenticators reset** with the actor **System** and the counters.

Users without a TOTP secret do not change. Without `--confirm`, the command stops with exit code 1 and changes nothing. It runs only when all migrations are applied. The output `{accounts, authenticators, pendingSetups, passkeyOnly, mfaRemoved}` contains only counters. A second run shows only zeros.

`SESSION_SECRET` also signs the device challenges for agent tokens. After the change, challenges that did not expire (a maximum of 2 minutes old) become invalid. The agents then request a new challenge. You cannot change `PASSWORD_PEPPER` with this procedure.

## Backups

The migration command keeps a journal with SQL checksums. It calculates the checksum over the file with LF line endings. The command does not automatically take over a database that already has tables but no journal. A PostgreSQL advisory lock makes sure that two parallel runs apply each migration only one time.

Versions before PostgreSQL used a different database, and there is no import of their data. An installation that exists starts with an empty PostgreSQL database. Make the owner again with `bootstrap-owner` and register the devices again.

### Automatic backup before migrations

Before the first pending migration, `migrate` writes a backup with `pg_dump --format=custom`. The file is `<BACKUP_DIRECTORY>/serverdesk-pre-<migration>-<UTC time>.dump`, with a `.sha256` file next to it. In the image, `BACKUP_DIRECTORY` is `/data/backups` on the volume `serverdesk_app-data`. Locally, it is `.data/backups`.

The command never overwrites a file. An empty database or no pending migration gives no backup. The JSON output names the backup.

If the backup fails, no migration runs. The message names the cause. Then check the free space, the write permission of the directory and the major version of `pg_dump`.

`migrate --skip-backup` skips the backup and writes a notice. Use it only when the database has its own backups, for example on Azure.

### Back up and restore

Make a backup at any time:

```sh
docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs backup
```

The command writes a custom-format dump and its `.sha256` file to `/data/backups`. It prints `{file, sha256, bytes}`. With `--output <file>`, it writes to that file. Copy the dumps and their `.sha256` files off the host, for example to a NAS share or to off-site storage. The volume alone is not a backup.

A dump holds password hashes, encrypted MFA secrets and token hashes, so keep the copies as private as the server: `backup` creates the dump and its `.sha256` file readable only by their owner (0600), and a new backup directory with 0700. The `.sha256` file only detects a damaged copy. It is no signature: whoever can change the dump can change the checksum too.

To restore a dump:

1. Stop the portal: `docker compose --env-file .env.runtime stop app`.
2. Put the dump and its `.sha256` file into `/data/backups`.
3. Restore into the empty database:

   ```sh
   docker compose --env-file .env.runtime run --rm app node scripts/selfhost.mjs restore --input /data/backups/<file>.dump
   ```

4. Start the portal: `docker compose --env-file .env.runtime up -d`.

`restore` refuses a dump whose `.sha256` file does not match. It refuses a database that already has tables, unless you add `--replace`. It uses `pg_restore` in one transaction and stops at the first error. Then it shows the applied and the pending migrations. Run `migrate` if a migration is pending.

`backup` and `restore` find `pg_dump` and `pg_restore` in `PG_BIN_DIR` or in `PATH`. Their major version must be the version of the server. The image contains version 17. The password goes to the tools only in their environment.

### The database password

The volume `serverdesk_db-data` keeps the password of the first start. If you change `DATABASE_PASSWORD` later, also change it in the database: `docker compose --env-file .env.runtime exec db psql -U serverdesk -c "ALTER ROLE serverdesk PASSWORD '<new password>'"`.

Also make separate backups of the runtime secrets and of the Caddy data volume with its CA. Make a separate backup of the private publisher key on the build computer, because it is not part of the NAS data volume. Test the restore in a separate Compose project.

For Blob Storage, use its own processes for backup, restore and retention. A container image alone contains no user data.

The file system object storage keeps objects by namespace under `OBJECT_STORAGE_PATH`. It does not read or move files in an earlier layout.

These functions still need a pilot test on real Windows devices:

- The Windows agent installation.
- The real MFA and passkey behavior in a trusted browser.
- Agent updates.
- Administrative device actions.

Remote Desktop stays paused, as in the current portal status.
