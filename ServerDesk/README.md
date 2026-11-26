# ServerDesk

ServerDesk is a web portal to manage Windows Server 2022/2025 and Windows 11 Pro/Enterprise. A Windows service sends monitoring and hardware data and does authorized jobs. The portal contains devices and groups, diagnostics, Windows management, files, terminal, runbooks and configuration monitoring. Remote Desktop is in development at this time, and the portal blocks it.

ServerDesk uses its own accounts with password and MFA. You can assign roles to the full portal, to device groups or to single devices. The agent makes outgoing HTTPS connections. The ReadOnly and Management modes control which actions the device permits.

## Development

Install Node.js 22.13 or later and pnpm 11.25.0. Then run these commands in this directory:

```powershell
node scripts/pipeline.mjs install
pnpm setup
pnpm db:migrate
pnpm owner:bootstrap --username admin --display-name Administrator
pnpm dev
```

Open the invitation link and configure the password and MFA. The user interface is at `https://localhost:3000` with a local development certificate. Do not commit configuration, data or credentials.

```powershell
node scripts/pipeline.mjs verify
```

This command runs the type check, lint, regression tests, self-hosting tests, the production build and the HTTP checks. `pnpm db:generate` makes new database migrations. The browser check `pnpm test:e2e` runs against a running installation.

## Operation and agent

One Docker image runs on a NAS, on your own server and on Azure. Docker Hub supplies the image as `docker.io/lostindreamz/nodiverna`. To operate it, you need only `compose.yaml` and an environment file ([Run with Docker Compose](docs/self-hosting.md#run-with-docker-compose)). Operation with Compose uses PostgreSQL in its own container and local file storage. Many Azure replicas use Azure Database for PostgreSQL and Azure Blob Storage. [Installation and deployment](docs/self-hosting.md) also tells you about local pipelines, HTTPS, backups and Azure Container Apps.

The [releases](https://github.com/LostInDreamZ/nodiverna/releases) page lists the versions and their changes.

To register a Windows device, use **Add device** in the portal. That page gives you the agent EXE, the personal registration file and the installation instructions. Updates use signed packages. For more information, read [Windows agent](agent/v3/README.md), [Device areas and hardware](docs/device-workspace.md), [Groups](docs/device-groups.md) and [Automation](docs/automation.md).
