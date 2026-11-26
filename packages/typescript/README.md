# mcp-feedback

Drop-in feedback for MCP servers. Add one call to a server built on the official MCP SDK and agents get a `submit_feedback` tool; what they report is stamped with the caller's identity and saved to a store you choose. A second set of tools lets a maintainer's agent read and synthesize it.

```sh
npm install mcp-feedback
```

The language-neutral spec (record schema, tool definitions, store contract, SQL layout) lives in the [repository](https://github.com/krishchow/feedback).

The package also carries agent skills for adding feedback to a server, recording a project's own facts about where its feedback is read, and reading and closing it out. Install them into a repository's agent harnesses (Claude Code, Codex, Cursor and others) with:

```sh
npx -y mcp-feedback@latest install --local    # or --user, for every project
```

Run it again after upgrading. It only replaces or removes files it wrote, and backs up any you edited first; `uninstall` takes them back out and `status` shows where they are.

## Use

```ts
import { registerFeedback, registerFeedbackReader, feedbackInstructions } from "mcp-feedback";
import { sqliteStore } from "mcp-feedback/sqlite";

const store = sqliteStore({ path: "./feedback.db" }); // once per process

// On the server agents use:
registerFeedback(server, { store });

// Optional. On a separate, maintainer-only server or endpoint:
registerFeedbackReader(adminServer, { store });
```

The reader tools list, fetch and count feedback, and `update_feedback_triage` closes out, dismisses or reopens one or many records with a note. Pass `readOnly: true` to leave that tool out. If you would rather not expose reader tools at all, use the CLI.

The reader tools show every caller's feedback, so they go on their own endpoint with their own credential, never on the one agents use. The library does no authentication itself; your middleware does, and by setting `req.auth` it also tells the library who is calling:

```ts
const bearer = (token: string, clientId: string) => (req, res, next) => {
  if (!token || req.get("authorization") !== `Bearer ${token}`) return res.status(401).end();
  req.auth = { token, clientId, scopes: [] }; // the SDK hands this to tools as authInfo
  next();
};

app.post("/mcp", bearer(process.env.AGENT_TOKEN, "myapp-agent"), handleAgentMcp);                  // registerFeedback
app.post("/mcp/feedback", bearer(process.env.MAINTAINER_TOKEN, "myapp-maintainer"), handleReader); // registerFeedbackReader
```

The agent endpoint's `clientId` ends up in each record's `identity`, and the reader endpoint's in `triaged_by`. The repository has a [runnable example](https://github.com/krishchow/feedback/tree/main/examples/express-server).

## Servers that run on their users' machines

A stdio server started with `npx`, or any server that runs on each user's machine, has no store its maintainer can read: a SQLite file there is never seen. Send its feedback to a hub you run instead. The hub writes into an ordinary store, which the reader tools and CLI read as above.

**1. Keys and a project key**, once, on your machine:

```sh
mcp-feedback ingest keygen --out ingest-key.json        # keep this file private
mcp-feedback ingest issue-key --project my-server --key ingest-key.json --issuer https://feedback.example.com
```

The project key is public by design: it ships in your package and can only enrol an installation.

**2. The server**, using the project key:

```ts
import { registerFeedback, feedbackConfirmInstructions } from "mcp-feedback";
import { feedbackDisabled, remoteStore } from "mcp-feedback/remote";

if (!feedbackDisabled()) {
  const store = remoteStore({ endpoint: "https://feedback.example.com", projectKey: "eyJhbGciOiJFZERTQSIs…" });
  registerFeedback(server, { store, requireConfirmation: true, destination: "the my-server maintainers" });
  void store.start(); // renews this machine's token, sends reports that could not go last time
}
```

On first use the installation enrols and gets its own token, kept in a per-user state directory. `start()` renews that token whenever the server starts and the token is more than a day old, so a machine in use keeps the same identity indefinitely; it contacts the hub only on a machine that has used feedback before. When the hub cannot be reached, the report is saved there and sent later, and the tool tells the agent where it is waiting; deleting the file cancels it. A report the hub refuses is not kept. `destination` adds a sentence to the tool's description saying where reports go, so the user knows before confirming. Users can turn feedback off with `MCP_FEEDBACK_DISABLED=1`.

**Reports as a GitHub user instead of an anonymous installation.** For your own and your team's tools, pass `signIn: "github"` (the hub needs GitHub sign-in turned on; see `hub/README.md`). The first report asks the user, through the agent, to open github.com/login/device and enter a code; the report waits on disk and goes out as soon as they approve. The sign-in is kept in the per-user state directory, shared by every server on the machine that reports to the same hub, and renewed by `start()`, so each machine signs in once. Reports then carry `identity.subject` = `github:<login>`. GitHub's own credential stays on the hub, which asks for no access beyond who the user is and discards it after reading their login.

**3. The hub.** One hub serves every server you distribute. Each server's reports are kept under its project name (`server.name`) in one store, and the hub accepts any project your key issued a project key for, so a new server needs a project key and nothing else. `hub/` in the repository has a Dockerfile and deployment notes; or run it directly:

```sh
MCP_FEEDBACK_READER_TOKEN=… mcp-feedback ingest serve --postgres "$DATABASE_URL" --key ingest-key.json \
  --issuer https://feedback.example.com --port 8787 [--project a --project b] [--trust-proxy] [--revoked revoked.txt]
```

`--project`, repeated, accepts only the projects listed. With `MCP_FEEDBACK_READER_TOKEN` set, the hub also serves the reader tools for every project at `/mcp`, so one URL and one credential reach all of it:

```sh
MCP_FEEDBACK_URL=https://feedback.example.com/mcp MCP_FEEDBACK_TOKEN=… mcp-feedback stats   # by_server shows each project
MCP_FEEDBACK_URL=https://feedback.example.com/mcp MCP_FEEDBACK_TOKEN=… mcp-feedback list --server my-server
```

**No separate host? Mount the hub in a server you already host.** The hub is a request handler, so an HTTP MCP server you already run (or any web app) can be the hub, and its existing store and reader endpoint then hold your stdio servers' feedback too. For an Express app:

```ts
import { createIngestHandler, toNodeListener } from "mcp-feedback/ingest";

const key = JSON.parse(process.env.MCP_FEEDBACK_INGEST_KEY!); // the file `mcp-feedback ingest keygen` wrote
const ingest = createIngestHandler({
  issuer: "https://app.example.com/api/ingest", // any stable string; tokens name it
  basePath: "/api/ingest",                       // routes: /api/ingest/v1/enroll, /api/ingest/v1/feedback
  keyring: { keys: [{ kid: key.kid, publicKey: key.publicKey }], signer: { kid: key.kid, privateKey: key.privateKey } },
  store: feedbackStore,                          // the server's own store: one queue, read through its reader endpoint
  tokenFingerprintKey: process.env.FEEDBACK_FINGERPRINT_KEY,
});

app.use("/api/ingest", toNodeListener(ingest));                       // 1. first (with Express, req.ip gives the client address)
app.use("/api", requireBearer);                                       // 2. the app's own auth, which ingest must not go through
app.use(express.json());                                              // 3. body parsing, which would consume the hub's request body
```

- **Order matters.** Register the hub before the app's authentication middleware, which would refuse installations (they bring their own signed tokens), and before any body parser. Or exempt its path from both.
- **Pick a path the deployment routes to the app.** If only `/api` reaches the server, mount under `/api/…`, with the same prefix as `basePath`.
- Installations use the mount point as their endpoint: `remoteStore({ endpoint: "https://app.example.com/api/ingest", … })`. Issue project keys with `--issuer` set to the same `issuer` string.
- Records the server's own `submit_feedback` writes keep their authenticated caller; records from installations carry an `ingest:*` scope and their project as `server.name`, so readers can tell them apart and use `--server`.
- Moving to a dedicated hub later means redeploying with the same key and issuer and changing the endpoint in the next release of each server. Installations on old releases keep sending to the old one, so keep it mounted until they have upgraded.

Elsewhere (Workers, Deno, Bun), the handler itself is a web-standard `(Request) => Promise<Response>`; use the `projects` option to accept only listed projects or give one a store of its own.

Read it like any other store: a reader endpoint over the same store (`registerFeedbackReader`), or `mcp-feedback list --postgres … --server my-server`.

**What a signature does and does not prove.** The hub's key signs every token, and the hub only accepts its own signatures, so forged and expired tokens are refused before anything is read. Each record says which kind of token sent it, in `identity.scopes`:

| Scope | Sent with | Means |
| --- | --- | --- |
| `ingest:install` | The token an installation got by enrolling | Anonymous. Records with the same `identity.subject` come from one installation. Anyone with the package can enrol. |
| `ingest:issued` | A token naming a person: `github:<login>` after GitHub sign-in, or one you issued with `mcp-feedback ingest issue-token --project my-server --subject alice@example.com` and passed to `remoteStore` as `token` | From that person. |

The content of every report is untrusted, whichever token sent it. The hub stamps identity, project, time and status itself and ignores those fields in the request; it limits reports per installation, per issued subject and per project each day; and revoking a `jti` or a subject refuses that token from then on. The protocol is in `spec/ingest.md`.

## The feedback loop

1. **Collect.** Agents call `submit_feedback` when a tool fails them. Each record starts as `new`.
2. **Read.** A maintainer, or their agent, reads the queue through the reader tools or the CLI and groups it into problems worth fixing.
3. **Work.** Items taken on are marked `triaged` with a note saying what will be done. Triaged means acknowledged and still open.
4. **Close.** Once the fix is released and checked, the items are marked `resolved` with the version or PR in the note. What will not be done is `dismissed` with the reason. Either can be reopened.

Nothing is ever deleted, and a record's content and submitter cannot be changed. The repository's `read-feedback` skill takes an agent through steps 2 to 4.

## CLI

The CLI reads either through a server's reader endpoint (the reader tools, mounted behind a maintainer credential) or straight from the store.

```sh
# Through a reader endpoint: needs its URL and credential, no database access.
export MCP_FEEDBACK_URL=https://example.com/mcp/feedback   # or --mcp <url>
export MCP_FEEDBACK_TOKEN=...                              # sent as a bearer token
npx -y mcp-feedback stats

# Or straight from the store.
npx -y mcp-feedback stats --db ./feedback.db               # or --postgres <url>

mcp-feedback list --status new --tool search_orders --text
mcp-feedback list --ref orderId=ord-123 --text            # everything reported about one object
mcp-feedback export --since 2026-11-01 > feedback.jsonl
mcp-feedback get <id> --text
mcp-feedback close <id> <id> --note "Fixed in 1.2"
mcp-feedback close <id> --dismiss --note "Working as intended"
mcp-feedback reopen <id>
```

`list` prints one page, newest first (`--limit`, 25 by default and 100 at most; `--cursor` takes the `next_cursor` from the page before). `export` prints every matching record, so use it to read a whole queue. `close`, `reopen` and `triage --status <s>` take up to 100 ids. `--note` replaces the record's note, leaving it out keeps the note, and `--clear-note` removes it. With a store, `--table` names a table other than `mcp_feedback`.

`mcp-feedback serve` runs the reader tools as a **stdio MCP server**, in front of any of those sources, so an agent session can read and triage feedback without connecting to a remote HTTP endpoint itself. Messages go to stderr; stdout carries the protocol. Add `--read-only` to leave out triage. For Claude Code:

```sh
claude mcp add myapp-feedback --scope user --env MCP_FEEDBACK_URL=https://example.com/mcp/feedback -- npx -y mcp-feedback serve
```

The server inherits the environment Claude Code starts in, so `MCP_FEEDBACK_TOKEN` exported in your shell reaches it without being written into the client's configuration. With a store (`serve --db` or `--postgres`), triage is recorded as `--by` or your username.

`MCP_FEEDBACK_DB` and `MCP_FEEDBACK_POSTGRES_URL` set the store from the environment. With a reader endpoint, pass `--prefix` if the server set a `toolPrefix`; `--by` does not apply, because the server records who triaged from the credential. The same client is available in code as `connectFeedbackReader` from `mcp-feedback/client`. Output is JSON unless you pass `--text`. Exit code 2 means bad input; 1 means a failure or an id that was not found.

Append `feedbackInstructions` to your server's `instructions` so agents know when to file. If you publish a tool catalog, merge in `feedbackToolCatalog`.

Requires Node 22.13 or later, `@modelcontextprotocol/sdk` 1.x and zod 3.25+ or 4.

## Identity

Each record carries who submitted it, read from the request, never from tool input: subject, client id, scopes, a fingerprint of the access token (not the token), session id, client name and version, user agent. For HTTP servers this depends on your auth middleware setting `req.auth`, which the SDK passes to tools as `authInfo`; without it identity fields are null.

```ts
registerFeedback(server, {
  store,
  requireIdentity: true, // refuse unauthenticated submissions
  resolveIdentity: (extra, defaults) => ({ subject: lookUpUser(extra.authInfo?.token) }),
});
```

## Context

Agents describe what happened in `context`: goal, expected and actual behaviour, the tool calls involved, repro steps, an excerpt and free-form `metadata`. Two fields let a reader rebuild the situation later, whatever your server's objects are:

- **`context.references`**: ids of the objects involved, keyed by what they are (`{ orderId: "ord-123", invoiceId: "inv-9" }`). Agents can include any; declare the ones that matter to your server with `contextFields` and they appear, with their descriptions, in the tool's input. Readers filter on them (`--ref orderId=ord-123`, or `reference` in `list_feedback` and `feedback_stats`).
- **`context.server_context`**: what the server knows and the agent does not, attached by `attachContext` when the feedback is submitted: versions, request ids, the state of the referenced objects at that moment. Agents cannot set it.

```ts
registerFeedback(server, {
  store,
  contextFields: { orderId: "The order the problem involved", invoiceId: "The invoice, if one was produced" },
  attachContext: async (record, extra) => ({
    version: process.env.APP_VERSION,
    order: record.context.references?.orderId ? await snapshotOrder(record.context.references.orderId) : undefined,
  }),
});
```

If `attachContext` throws, the feedback is still stored without it and the error goes to `onError`.

## Options

| Option | Purpose |
| --- | --- |
| `store` | Where records go. Required. |
| `resolveIdentity` | Override identity fields for a request. |
| `requireConfirmation` | Tell agents to file only after the user confirms the exact feedback. Use `feedbackConfirmInstructions` in place of `feedbackInstructions`, and `feedbackToolCatalogFor(options)` for catalogs. |
| `requireIdentity` | Refuse submissions with no subject and no token fingerprint. |
| `contextFields` | Ids agents should include in `context.references`, as name → description. |
| `attachContext` | Attach what the server knows (versions, object state) as `context.server_context`. |
| `redact` | Scrub a record before it is stored. |
| `limits` | Override size limits (see the spec for defaults). |
| `toolPrefix` | Prefix for tool and prompt names. |
| `serverInfo` | Server name and version to record; defaults to the server's own. |
| `tokenFingerprintKey` | Secret that makes token fingerprints an HMAC. Recommended; keep it stable and the same on every instance. |
| `onError` | Receives storage errors, which are hidden from the agent. |

`registerFeedbackReader` takes:

| Option | Purpose |
| --- | --- |
| `store` | The store to read and triage. Give this or `reader`. |
| `reader` | A `FeedbackReaderClient`, such as the one `connectFeedbackReader` returns, to serve another server's reader endpoint again. |
| `readOnly` | Leave out `update_feedback_triage`. |
| `resolveIdentity` | Override who triage is recorded as. |
| `toolPrefix` | Prefix for tool and prompt names. |
| `tokenFingerprintKey` | The same key as on the submit side, for a reader whose credential has no client id or subject. |
| `onError` | Receives storage errors, which are hidden from the agent. |

## Statuses

| Status | Meaning |
| --- | --- |
| `new` | Filed and not yet looked at. Also what reopening sets. |
| `triaged` | Acknowledged, perhaps being worked on. Still open. |
| `resolved` | Fixed or delivered. The note says where. |
| `dismissed` | Will not be acted on. The note says why. |

## Stores

| Store | Import | Notes |
| --- | --- | --- |
| SQLite | `mcp-feedback/sqlite` | Default. Uses Node's built-in `node:sqlite`, so there is no native module to install. On Node versions where that module is still experimental, Node prints a warning. |
| Postgres | `mcp-feedback/postgres` | `postgresStore({ client: pool })` with any client that has `query(text, params)`, such as a `pg.Pool`. Timestamps are `TIMESTAMPTZ`. Creates its table and indexes on first use if missing; pass `migrate: false` only if the database user cannot create tables and your migrations reach every environment. |
| Drizzle schema | `mcp-feedback/drizzle` | `mcpFeedbackTable` (or `feedbackTable(name)`) to export from your Drizzle schema, so `drizzle-kit` creates the table and never drops it. Tests keep it identical to the store's own DDL (`spec/sql/postgres.sql`), so keep the store's table creation on as well: it covers databases your schema tool does not reach. |
| Memory | `mcp-feedback` | `memoryStore()`, for tests. |

To write your own, implement `FeedbackStore` and check it with the conformance suite:

```ts
import { defineFeedbackStore } from "mcp-feedback";
import { runStoreConformance } from "mcp-feedback/testing";

const store = defineFeedbackStore({ insert, get, list, updateTriage, stats });
await runStoreConformance(store); // rejects on the first failing case
```

The package does not rate-limit submissions; rely on your server's existing limits. The ingest hub is the exception: it has daily quotas of its own.
