# Running an mcp-feedback hub

A hub collects the feedback that installed copies of your MCP servers send: stdio servers started with `npx`, CLIs, anything that runs on its users' machines and so has no database you can read. One hub serves all your servers. Each server's reports are kept under its own project name, and one reader endpoint shows them all, or one at a time.

```
user's machine                          your host
┌─────────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ your server (stdio)     │──────────▶ │ hub   POST /v1/enroll        │──▶ Postgres or SQLite
│   remoteStore()         │            │       POST /v1/feedback      │      (every project,
└─────────────────────────┘            │       POST /mcp  (reader)    │◀──    one store)
                                       └──────────────────────────────┘
                                                    ▲
                                  you: mcp-feedback stats / list --server <project>
```

The hub is the `mcp-feedback ingest serve` command, packaged as a container here. Protocol and trust model: [spec/ingest.md](../spec/ingest.md).

## What you need

| | |
| --- | --- |
| A host that runs a container | Any: Fly.io, Railway, Render, a VPS with Docker, Kubernetes. One small instance is plenty. |
| HTTPS | Installations refuse plain `http` to anything but localhost. Most hosts terminate TLS for you; on a VPS, put Caddy or nginx in front. |
| A stable public URL | Tokens are valid only for the URL they name (the issuer). Choose it before issuing anything; changing it means reissuing every key. |
| Storage | Postgres (recommended, and required on hosts whose disks do not persist), or SQLite on a persistent volume mounted at `/data`. |
| Node 22.13+ on your own machine | To make the signing key and issue tokens with `npx mcp-feedback`. |

## 1. Make the signing key (on your machine, once)

```sh
npx -y mcp-feedback ingest keygen --out hub-key.json
```

`hub-key.json` holds the private key. It signs every token the hub accepts, so treat it like any production secret: keep it in a password manager or secret store, never in a repository, and give the hub a copy as a secret. Anyone with it can mint tokens for any project.

## 2. Configure the container

| Variable | Required | |
| --- | --- | --- |
| `MCP_FEEDBACK_INGEST_ISSUER` | yes | The hub's public URL, e.g. `https://feedback.example.com`. |
| `MCP_FEEDBACK_INGEST_KEY` | yes | The contents of `hub-key.json` on one line (`node -e "console.log(JSON.stringify(require('./hub-key.json')))"`), or a path to the file inside the container. |
| `MCP_FEEDBACK_POSTGRES_URL` or `DATABASE_URL` | one of | Postgres. The hub creates its table (`mcp_feedback`, or `MCP_FEEDBACK_TABLE`) on start. |
| `MCP_FEEDBACK_DB` | these | SQLite, e.g. `/data/feedback.db`, with `/data` on a persistent volume. |
| `MCP_FEEDBACK_READER_TOKEN` | recommended | 32+ random characters (`openssl rand -base64 32`). Turns on the reader endpoint at `/mcp` for every project. Without it, read the database directly. |
| `MCP_FEEDBACK_FINGERPRINT_KEY` | recommended | Random and stable. Keys the token fingerprints stored with each report. |
| `MCP_FEEDBACK_INGEST_TRUST_PROXY` | behind a proxy | `1` to take the client address from `X-Forwarded-For`, which limits enrolments per address. Only behind a proxy that overwrites that header. |
| `MCP_FEEDBACK_INGEST_OPEN` | recommended | `1` lets a server enrol by naming its project, so connecting a new server needs nothing from you (step 4). Anyone who finds the hub can then file under any name it accepts, within the quotas. |
| `MCP_FEEDBACK_INGEST_PROJECTS` | no | Comma-separated. Accept only these projects. Empty accepts every project your key issued a project key for, and with open enrolment any name. |
| `MCP_FEEDBACK_INGEST_REVOKED` | no | Comma-separated token ids (`jti`) or subjects to refuse. Read on start, so restart after changing it. |
| `MCP_FEEDBACK_GITHUB_CLIENT_ID` | no | Turns on GitHub sign-in; see "GitHub sign-in" below. |
| `MCP_FEEDBACK_GITHUB_ORGS`, `MCP_FEEDBACK_GITHUB_USERS` | no | Comma-separated. Only members of these organisations, or these logins, may sign in. |
| `PORT` | no | Default `8787`. Most hosts set it. |

The container listens on `0.0.0.0`, answers `GET /healthz`, runs as an unprivileged user, and shuts down cleanly on `SIGTERM`. It checks the database on start, so a wrong connection string fails the deploy instead of the first report.

## 3. Deploy

**Already host an HTTP MCP server or web app?** You can skip this section and mount the hub inside it instead: it becomes the hub, using its own store and reader endpoint. See "No separate host?" in the [package README](../packages/typescript/README.md#servers-that-run-on-their-users-machines) for the code and the two things to get right (route order and path). The rest of this section is for a dedicated hub.

Build from the repository root:

```sh
docker build -f hub/Dockerfile -t mcp-feedback-hub .
```

Then run it wherever you host containers, with the variables above as secrets. For example:

```sh
docker run -d --name mcp-feedback-hub -p 8787:8787 \
  -e MCP_FEEDBACK_INGEST_ISSUER=https://feedback.example.com \
  -e MCP_FEEDBACK_INGEST_KEY="$(node -e "console.log(JSON.stringify(require('./hub-key.json')))")" \
  -e DATABASE_URL=postgres://… \
  -e MCP_FEEDBACK_READER_TOKEN="$(openssl rand -base64 32)" \
  -e MCP_FEEDBACK_FINGERPRINT_KEY="$(openssl rand -base64 32)" \
  -e MCP_FEEDBACK_INGEST_TRUST_PROXY=1 \
  mcp-feedback-hub
```

Keep the reader token you generated: it is the credential for reading.

**On a VPS**, `docker-compose.yml` here runs the hub with Postgres:

```sh
cp hub/.env.example hub/.env      # fill it in
docker compose -f hub/docker-compose.yml up -d --build
```

It binds to `127.0.0.1:8787`; point your TLS proxy at it (Caddy: `feedback.example.com { reverse_proxy 127.0.0.1:8787 }`).

Check it: `curl https://feedback.example.com/healthz` answers `{"ok":true}`.

## 4. Connect a server

With `MCP_FEEDBACK_INGEST_OPEN=1`, there is nothing to issue: the server names its project, `remoteStore({ endpoint: "https://feedback.example.com", project: "my-server" })`, and the hub needs no change. Ask your agent to "add agent feedback to this MCP server" with the `add-feedback-to-mcp-server` skill (`npx -y mcp-feedback@latest install --local` installs it), which wires it for you.

Without open enrolment, issue each server a project key, and pass it as `projectKey` in place of `project`:

```sh
npx -y mcp-feedback ingest issue-key --project my-server --key hub-key.json --issuer https://feedback.example.com
```

The project key is public by design: it goes in the server's source and can only enrol an installation. What it adds is your say over which project names exist on the hub.

Reports are anonymous by default: each installation has its own `install:…` subject. To have your own and your team's reports carry who sent them, turn on GitHub sign-in (next section) and pass `signIn: "github"` to `remoteStore` in those servers. For a one-off without GitHub, you can still issue a token by hand and deliver it privately:

```sh
npx -y mcp-feedback ingest issue-token --project my-server --subject alice@example.com --days 90 --key hub-key.json --issuer https://feedback.example.com
```

## GitHub sign-in (optional)

With it on, a server that passes `signIn: "github"` asks its user to sign in once per machine, by entering a code at github.com/login/device, and their reports carry `github:<login>`. The sign-in is shared by every server on the machine that reports to this hub and renewed whenever one of them starts, so nobody signs in twice and nobody mints tokens by hand.

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App** (or the same under an organisation). Any homepage and callback URL will do, e.g. the hub's URL; neither is used. After creating it, tick **Enable Device Flow** and save. No client secret is needed.
2. Set `MCP_FEEDBACK_GITHUB_CLIENT_ID` on the hub to the app's client id.
3. Optionally limit who may sign in: `MCP_FEEDBACK_GITHUB_ORGS` (members of these organisations; the hub then asks GitHub for `read:org`) or `MCP_FEEDBACK_GITHUB_USERS` (these logins).

The hub runs the device flow itself: GitHub's credential never reaches the user's disk, the hub asks for nothing beyond who the user is, and it discards GitHub's token once it has read the login. What the user's machine keeps is a hub token for `github:<login>` that lasts 180 days and is renewed on each start. If one leaks, it lets someone file feedback as that person, within their daily limit, until you revoke `github:<login>`.

## 5. Read

```sh
export MCP_FEEDBACK_URL=https://feedback.example.com/mcp
export MCP_FEEDBACK_TOKEN=<the reader token>
npx -y mcp-feedback stats                      # every project; by_server shows the split
npx -y mcp-feedback list --server my-server --status new --text
npx -y mcp-feedback close <id> --note "Fixed in 1.4.1"
```

For agent sessions, `npx -y mcp-feedback serve` with the same two variables gives an agent the reader tools as a local MCP server, and the `read-feedback` skill knows how to work the queue.

## Operating it

- **Quotas.** By default each installation can file 20 reports a day, each issued token 200, each project 500, and the whole hub 2000. To change them, mount the hub as a library (`createIngestHandler` in the package README).
- **Open enrolment gone wrong.** If strangers start filing under made-up names, set `MCP_FEEDBACK_INGEST_PROJECTS` to the names you use and restart: everything else is refused from then on, including installations that already enrolled.
- **Revoking.** Records show each submitter's subject (`install:…`, `github:<login>`). To stop a misbehaving installation, a person, or a leaked token, add its subject or `jti` to `MCP_FEEDBACK_INGEST_REVOKED` and restart. Revoking `github:<login>` also stops that person's sign-in from renewing.
- **Renewal traffic.** Each machine that has used feedback renews its token at most once a day, when a server starts. Machines that never filed feedback never contact the hub. To rotate a project key, issue a new one, ship it in a release, then revoke the old key's `jti`.
- **Several instances.** Quotas are counted in the database, so they hold across instances. The per-address enrolment limit is kept in each instance's memory; with many instances, mount the hub as a library and add an `allowEnrollment` hook backed by shared storage.
- **Backups.** The database is the only state. Back it up as you would any other.
- **Upgrading.** Rebuild the image. The table is created if missing and new indexes are added on start; nothing else changes.
