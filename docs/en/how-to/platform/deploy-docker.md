---
title: "Deploy the server with Docker"
description: "Published images, offline imports, mounted source, and persistent runtime storage."

---

## Three-container deployment

From the repository root, run `bash scripts/deploy-docker.sh up` with Python 3, Docker Engine and Compose v2 supporting `--wait`. The first run builds the application image and starts PostgreSQL 16, ClickHouse 26.8 and one application container running Core and Web. Each database owns a separate volume. Access Web at `http://127.0.0.1:3000`. Select `--transaction sqlite` or `--transaction opengauss` on first install to use another backend.

Keep the private deployment directory (default `~/.agent-insight-docker`) with the data volumes. Reuse `--instance-dir` on subsequent commands. On first install, set `WEB_HOST_PORT`, `CH_HOST_PORT` and the selected backend's `PG_HOST_PORT`, `OG_HOST_PORT` or `SQLITE_HOST_PORT` when running multiple instances. To serve other hosts, set `DB_BIND_ADDRESS` to the database host’s private interface on first install, then configure the application with that address and the published ports. Set `WEB_BIND_ADDRESS` to select the Web interface. Defaults bind to loopback. Use `up --build` to rebuild local images. Use `status` and `stop` for the instance.

### Independent services

Run `bash scripts/deploy-docker.sh db --transaction postgresql` then `bash scripts/deploy-docker.sh app` with the same instance directory. For individually managed services use the four [database Compose files, application file and JSON examples](../../../../deploy/docker/). Supply private database passwords via the environment. Use a common Compose project name for service discovery.

```bash
docker compose -p insight-demo -f deploy/docker/compose.clickhouse.yml up -d --wait
docker compose -p insight-demo -f deploy/docker/compose.postgresql.yml up -d --wait
# Set STORAGE_CONFIG to an absolute private (0600) JSON file with real credentials.
docker compose -p insight-demo -f deploy/docker/compose.app.yml up -d --build --wait
docker compose -p insight-demo -f deploy/docker/compose.app.yml stop app
```

For an independently managed database, set its credential and run `docker compose -p insight-demo -f deploy/docker/<filename> up -d --wait`. Run ClickHouse plus one transactional backend.

| Service | Filename | Credential | Default host port |
|---|---|---|---|
| ClickHouse | `compose.clickhouse.yml` | `CLICKHOUSE_PASSWORD` | 18123 |
| PostgreSQL | `compose.postgresql.yml` | `PG_PASSWORD` | 15432 |
| openGauss | `compose.opengauss.yml` | `OG_PASSWORD` (8–32 characters including upper case, lower case, a digit and a supported special character) | 15433 |
| SQLite service | `compose.sqlite.yml` | `SQLITE_TOKEN` | 18080 |

To customize a generated configuration, edit a private copy of `storage.json` outside the deployment directory. For existing stores, run `bash scripts/deploy-docker.sh app --config /absolute/storage.json`. The JSON supplies one transactional backend and ClickHouse. Within the same network use `postgres:5432`, `opengauss:5432` or `sqlite:8080` with `http://clickhouse:8123`. On the database host use its published ports (15432, 15433, 18080 and 18123 by default). For remote databases provide routable addresses, credentials and CA certificates. Populate `control.dsn/schema/artifacts` for PostgreSQL or openGauss. The launcher imports the official 7.0.0-RC3 archive for the Docker server architecture on first use, or reuses the local image. Allow temporary disk space for the archive. Set `OPENGAUSS_IMAGE` to select an existing image, including when using standalone Compose. [Official openGauss container installation](https://docs.opengauss.org/zh/docs/7.0.0-RC3/installation_guide/installing_the_container_image.html) For SQLite service mode supply `control.endpoint/token/artifacts`; set a matching high-entropy `SQLITE_TOKEN`. Remote SQLite supports TLS via mounted `SQLITE_TLS_CERT` and `SQLITE_TLS_KEY`. Set these variables in a Compose override with `SQLITE_HEALTH_ENDPOINT` pointing to an HTTPS origin matching the certificate and `SSL_CERT_FILE` for a private CA. The file-based SQLite configuration continues to work for local use. Set the ClickHouse endpoint, database, username and password for every backend.

For a source installation use Node 22+, npm and Python (3.11–3.13 for the relational driver). Update paths and addresses for the application host, run `bash scripts/install.sh --check --config /absolute/storage.json` then `bash scripts/install.sh --config /absolute/storage.json`. The precheck needs a Python environment with the selected driver. The application only needs database connectivity. Verify a real Trace round trip and back up both stores, private deployment records and artifacts together before upgrades.

<details>
<summary>Historical single-container images and source mounts (use the instructions for the corresponding release)</summary>

## Option 1: Pull from Docker Hub

```bash
docker pull karaggagent/agent-insight:latest

mkdir -p ~/.agent-insight/data
chmod -R 777 ~/.agent-insight

docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:latest

curl -i http://localhost:3000/
```

This mounts the current host user's `~/.agent-insight` at `/data/agent-insight` inside the container. The SQLite database, Skill attachments, and evaluation runtime files are stored under its `data/` directory. Keeping this mount lets a restarted or replacement container reuse the data. The default database path on the host is:

```text
~/.agent-insight/data/witty_insight.db
```

## Option 2: Import an offline `.tar` image

If the server cannot reach Docker Hub, obtain an offline image archive, such as `agent-insight-0.5.0-image.tar`, then import and run it:

```bash
docker load -i agent-insight-0.5.0-image.tar
docker images | grep agent-insight

mkdir -p ~/.agent-insight/data
chmod -R 777 ~/.agent-insight

docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:0.5.0

curl -i http://localhost:3000/
```

If `docker load` reports a tag other than `karaggagent/agent-insight:0.5.0`, use the actual image name shown by `docker images | grep agent-insight`.

You can use a Docker volume instead of a host directory:

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v agent-insight-data:/data/agent-insight \
  karaggagent/agent-insight:latest
```

To pin a production deployment to a version, replace `latest` with an explicit tag, for example `0.5.0`:

```bash
docker pull karaggagent/agent-insight:0.5.0
docker stop agent-insight
docker rm agent-insight
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:0.5.0
```

The home directory in these commands belongs to the user running Docker on the server. Preserve the same mount when upgrading so the data survives image replacement.

## Option 3: Mount source and rebuild on restart

Use this mode when a server needs to follow source changes. After updating the checkout with `git pull`, restart the container to rebuild from source without publishing a new npm package or image for every code change.

Set the container environment variable `AGENT_INSIGHT_SOURCE_DIR` to the source path **inside the container**:

```bash
git clone https://gitcode.com/openeuler/agent-insight.git /srv/agent-insight

# Before the first start, create the data directory and assign it to the
# container's node user (uid 1000). Docker-created directories belong to root
# and can cause Prisma to report "attempt to write a readonly database".
mkdir -p ~/.agent-insight/data
chown -R 1000:1000 ~/.agent-insight

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -e AGENT_INSIGHT_SOURCE_DIR=/src \
  -v /srv/agent-insight:/src:ro \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:latest
```

The equivalent Compose configuration (`compose.yaml`) can also build the image:

```yaml
services:
  agent-insight:
    image: agent-insight:src
    build:
      context: /srv/agent-insight              # Repository root containing Dockerfile
      args:
        AGENT_INSIGHT_VERSION: "0.5.4"         # npm version supplying image dependencies
    container_name: agent-insight
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      AGENT_INSIGHT_SOURCE_DIR: /src
      NODE_OPTIONS: --max-old-space-size=2048  # Limit build memory on smaller hosts
    volumes:
      - /srv/agent-insight:/src:ro             # Read-only source
      - ${HOME}/.agent-insight:/data/agent-insight
      - agent-insight-build:/app/source        # Retain build cache across container recreation

volumes:
  agent-insight-build:
```

To update the source:

```bash
cd /srv/agent-insight && git pull
docker compose restart agent-insight   # Without Compose: docker restart agent-insight
docker compose logs -f agent-insight   # Follow "Building from source..." until the build finishes
```

Use `restart` for source changes. When container configuration has not changed, `up -d` does nothing and does not trigger a rebuild. When `package.json` dependencies change and the image must also be rebuilt, use `docker compose up -d --build`.

### Update an offline server from a source ZIP

The update script uses English help, progress, and error messages to avoid terminal encoding problems. First change the existing Compose source mount to `${SOURCE_RELEASE:?SOURCE_RELEASE is required}:/src:ro`. Keep `AGENT_INSIGHT_SOURCE_DIR=/src` and the existing data mounts. Copy `scripts/update-source.sh` to the server and set its `DEFAULT_COMPOSE_FILE` near the top (default: `/srv/agent-insight/compose.yml`). Then run:

```bash
bash update-source.sh --zip /path/to/agent-insight.zip
# Override the Compose path; RELEASES_DIR overrides the extraction directory.
# Its default is /srv/agent-insight/releases.
RELEASES_DIR=/srv/agent-insight/releases bash update-source.sh \
  --zip /path/to/agent-insight.zip --compose /srv/agent-insight/compose.yml
```

The host needs Bash, Python 3, Docker Compose v2, permission to write the extraction directory, and permission to operate Docker. The script extracts a new release directory, detects wrapper directories in downloaded ZIP files, exports `SOURCE_RELEASE`, and runs `docker compose -f <configuration-file> up -d --force-recreate --pull never --no-build`, as in a manual update.

It does not additionally validate the Compose source mount or wait for health checks. The application may still be building after the command returns: inspect logs, the page, and business functions. Compose must reference `SOURCE_RELEASE` in its source mount; exporting the variable does not change a hard-coded path. Use the same Compose file and project name that manage the existing container; pass a custom project name through `COMPOSE_PROJECT_NAME` when needed.

The script does not pull or build images or clean up old release directories. On failure, it retains source files and reports the error. It does not automatically back up or roll back the database. The exported `SOURCE_RELEASE` does not persist in the calling shell; before running Compose separately later, set it to the source path printed by the script.

Back up the database before a ZIP update, and verify that the new branch's dependencies, database schema, and upgrade logic are compatible with the deployment. Dependency changes still require an updated image. The entrypoint runs database preparation and schema synchronization, even if this update did not change the schema file. A ZIP update can therefore modify the database. Editing the source copy of `docker-entrypoint.sh` does not replace the entrypoint already installed in the image.

### Source-mode behavior

- Without `AGENT_INSIGHT_SOURCE_DIR`, the container runs the prebuilt `agent-insight` npm package in the image, as before.
- With the variable set, startup copies source into `/app/source`, excluding `node_modules`, `.next`, `.git`, `data/`, and `exclude/`. It then runs `prisma db push`, `prisma generate`, and `npm run build`, before starting the standalone service through the control gateway, as in the default mode. A read-only host source mount is sufficient: build outputs do not write into it, and its ownership need not match the container's `node` user.
- Builds use dependencies preinstalled in the image, including build-time dependencies such as `tailwindcss` and `typescript`. The source directory does not need `npm install`. **Rebuild the image when source changes add dependencies or change exact pinned versions in `package.json`.** Startup checks for missing dependencies and exact-version mismatches, lists the problems, and exits rather than only warning. Version-range declarations do not provide a complete compatibility check.
- The first cold build takes several minutes. The port is not listening during the build, and `health: starting` is expected. Restarts reuse `.next/cache`; retaining that cache after container recreation requires a volume at `/app/source`, as shown above.
- The service is unavailable during the build. If downtime is unacceptable, start and verify a new container on another port before switching the service port or traffic.
- An invalid source path causes an immediate error and exit, with no silent fallback to the image's bundled package. With `restart: unless-stopped`, this appears as repeated restarts; check the first log message. Validation happens before source copying, leaving the data directory and previous build cache untouched on validation failure.
- Prepare the data directory for container uid 1000 **before the first start**. A directory created automatically by Docker belongs to root and can make `prisma db push` fail with `attempt to write a readonly database`.
- Pass the variable through the container environment (`-e` or Compose `environment`). Writing it in `~/.agent-insight/.env` has no effect: the entrypoint selects the code to run before reading that file.

## Troubleshoot startup

If port `3000` is unreachable after startup, inspect the container and logs:

```bash
docker ps -a --filter name=agent-insight
docker logs --tail=200 agent-insight
curl -i http://127.0.0.1:3000/
```

`unable to open database file` commonly indicates a missing host mount directory or insufficient permissions. Confirm that the directory exists and the container's `node` user can write to `/data/agent-insight/data`.

## Build your own image

The repository-root `Dockerfile` installs `agent-insight@latest` from npm by default. It does not copy application source into the image:

```bash
docker build --pull --no-cache -t agent-insight:npm-latest .
docker run -d --name agent-insight -p 3000:3000 -v agent-insight-data:/data/agent-insight agent-insight:npm-latest
curl -i http://localhost:3000/
```

To pin the npm version:

```bash
docker build --pull --build-arg AGENT_INSIGHT_VERSION=0.5.0 -t agent-insight:0.5.0 .
```

To test local changes without publishing an npm package first, use [mounted source mode](#option-3-mount-source-and-rebuild-on-restart), or the `npm pack` → upload `.tgz` → Docker cached-build workflow in [Docker test builds, Chinese](../../../zh/how-to/platform/docker-testing.md).

## Connect Agents from their own runtime environment

The container runs the Agent Insight server. Run integration commands for OpenCode, Claude Code, OpenClaw, LangChain, and other frameworks on the machine or in the container where that Agent actually runs. This repository's `Dockerfile` prioritizes SQLite and does not include OpenGauss runtime dependencies.

The OpenCode integration command also runs `install-ras` on the Agent machine, using an Agent Insight package version matching the server, and installs Agent RAS under `~/.agent-insight/ras/runtime/`. The installer uses an isolated npm cache to download only the published `.tgz`; it does not temporarily install the whole dashboard dependency set through `npx`. After installation, a read-only RAS event-receiver preflight compiles the route on a source development server and validates the current API Key. A failed preflight warns without blocking ordinary Trace plugins or the dashboard. In a containerized dashboard deployment, install the OpenCode RAS plugin in the OpenCode runtime environment.

Features such as `opencode-live` trigger analysis and trajectory evaluation launch `opencode` **locally on the server**. Keep the npm dependencies intact in images built from the current `Dockerfile`, and provide container network access to the model provider. These evaluations do not reuse a separate OpenCode process on the host.

After deployment, continue with [your first Trace](../../tutorial/platform/01-quick-start.md). Before an upgrade, read [upgrade and rollback](./upgrade-and-rollback.md).

[中文权威版本](../../../zh/how-to/platform/deploy-docker.md)

</details>

## UBI9/OpenShift image

Follow [Deploy the server on OpenShift](./deploy-openshift.md) for project permissions, image preparation, PVC/SCC, HTTPS Routes, Developer Sandbox builds, business acceptance and troubleshooting.

For UBI9, full DNF, and downstream patch builds, use the separate source-based `Dockerfile.openshift` image. It uses the same pinned UBI9 Node.js 22 base for dependency installation, build, and runtime. Override `UBI_NODE_IMAGE` with an approved enterprise mirror or digest that supplies Node.js 22, npm, and full `dnf`; `microdnf` alone is insufficient. The generic Dockerfiles retain their existing base images and default users.

This candidate runs the prebuilt application and does not support mounted-source mode through `AGENT_INSIGHT_SOURCE_DIR`. Rebuild the image when application source changes. Startup regenerates the package-local Prisma client under the runtime UID to avoid overwriting root-owned files.

The updated shared Docker entrypoint starts `scripts/control-server.js` for both HTTP and WebSocket control traffic. Its dispatch listener defaults to the application port plus one and binds only to container loopback; no additional published port is required. Update and restart installed clients as well: replacing a server image does not update client scripts. Verify public WSS and long-poll fallback, including disconnected deliveries and missing ACKs, in addition to HTTP health checks.

Application `python3` uses Python 3.11 from UBI AppStream; DNF keeps its system Python. The default runtime disables the inherited CodeReady Builder repository and retains UBI BaseOS/AppStream for package updates. Enterprise bases must provide Python 3.11 through approved repositories.

The fault catalog requires PyYAML, and the RAS catalog requires Pydantic. `scripts/requirements-container.txt` pins both and their transitive dependencies with CPython 3.11 Linux wheel SHA-256 hashes. Use `--build-arg PIP_INDEX_URL=<approved-Python-index>` to change the package index while retaining hash verification. The image check exercises YAML, fault and RAS catalogs, and the thinking-loop configuration fields. DNF updates RPMs; Python/npm dependencies require their own reproducible rebuild and scan.

Use [`deploy/openshift.yaml`](../../../../deploy/openshift.yaml) after replacing the example image with an accessible delivered image or digest and confirming node architecture, PVC size, and the default StorageClass:

```bash
oc apply -n <project> -f deploy/openshift.yaml
oc rollout status -n <project> deployment/agent-insight
oc get -n <project> route/agent-insight
```

```bash
docker build --platform linux/amd64 -f Dockerfile.openshift \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t agent-insight:openshift-ubi9-test .
node scripts/verify-openshift-image.cjs agent-insight:openshift-ubi9-test
```

The delivered image defaults to UID 0 so a downstream Dockerfile can inherit root for package updates without a `USER` instruction:

```dockerfile
FROM <approved-component-image-and-digest>
RUN dnf -y update && dnf clean all
```

Runtime OpenShift pods must use the non-root UID assigned by their SCC. Do not set a fixed `runAsUser`, relax the SCC, or request privileges. Use `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, dropped capabilities, and the runtime-default seccomp profile. Start with one replica and a `Recreate` update strategy. Mount a PVC at `/data/agent-insight` and verify its group permissions, SQLite locking, and persistence. Supply model credentials through Secrets or external configuration. If changing the runtime root, also update HOME and every XDG home directory. Prisma initialization writes to designated image directories; a read-only root filesystem is not currently claimed. OpenGauss dependencies are not included.

Configure workload startup/readiness/liveness probes separately from Docker HEALTHCHECK. Expose port 3000 through a Service/Route and validate HTTPS, SSE, WebSocket, and gateway timeouts. The verification script checks restricted local container startup under two non-root UIDs, writable HOME/XDG paths, Prisma, OpenCode, the control gateway WebSocket handshake, RAS configuration, and restart persistence. It does not call models or replace live SCC/PVC/Route, public WSS/SSE, and business acceptance.

Record source revision, build-file checksum, base and delivered image digests, RPM versions and repository provenance, and scan both original and patch images. A successful DNF command without updating an affected package does not prove a CVE is fixed. npm and bundled-binary vulnerabilities require separate handling. Follow [upgrade and rollback](./upgrade-and-rollback.md) for data-safe updates; changing the image alone does not revert database changes.

For npm security fixes, update dependency declarations and the lockfile, rebuild with `npm ci`, and scan the resulting image. Update compatible parent dependencies when their version constraints exclude the fixed transitive package. Installing packages only inside a running container does not produce a reproducible delivery image.
