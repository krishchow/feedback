# mcp-feedback

Drop-in feedback for MCP servers. Add one call to a server built on the official MCP SDK and agents get a `submit_feedback` tool; what they report is stamped with the caller's identity and saved to a store you choose. A second set of tools lets a maintainer's agent read and synthesize it.

- `spec/` is the language-neutral contract: record schema, tool definitions, store contract, conformance vectors, SQL layout. Start at [`spec/SPEC.md`](spec/SPEC.md).
- `packages/typescript/` is the reference implementation for `@modelcontextprotocol/sdk`, published on npm as [`mcp-feedback`](https://www.npmjs.com/package/mcp-feedback).
- `skills/` holds agent skills for the two sides of the loop: maintainers adding feedback to a server, and whoever reads what comes in. The repo is a plugin marketplace for Claude Code and Codex, so they install directly.
- `examples/express-server/` is a runnable stateless HTTP server using both tool sets.

## Install the skills

Claude Code:

```
/plugin install mcp-feedback --marketplace krishchow/feedback
```

On older versions: `/plugin marketplace add krishchow/feedback`, then `/plugin install mcp-feedback@mcp-feedback`.

Codex reads `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json` from this repo.

| Skill | For |
| --- | --- |
| `add-feedback-to-mcp-server` | The producer side: wire the library into a server, then update the server's own skills, instructions and docs so agents use `submit_feedback`. |
| `read-feedback` | The consumer side: read, summarise and close out feedback, over the CLI or the MCP reader tools. |

## Use (TypeScript)

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

### CLI

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

`mcp-feedback serve` runs the reader tools as a **stdio MCP server**, in front of any of those sources, so an agent session can read and triage feedback without connecting to a remote HTTP endpoint itself. Messages go to stderr; stdout carries the protocol. Add `--read-only` to leave out triage. For Claude Code:

```sh
claude mcp add myapp-feedback --scope user --env MCP_FEEDBACK_URL=https://example.com/mcp/feedback -- npx -y mcp-feedback serve
```

The server inherits the environment Claude Code starts in, so `MCP_FEEDBACK_TOKEN` exported in your shell reaches it without being written into the client's configuration. With a store (`serve --db` or `--postgres`), triage is recorded as `--by` or your username.

`MCP_FEEDBACK_DB` and `MCP_FEEDBACK_POSTGRES_URL` set the store from the environment. With a reader endpoint, pass `--prefix` if the server set a `toolPrefix`; `--by` does not apply, because the server records who triaged from the credential. The same client is available in code as `connectFeedbackReader` from `mcp-feedback/client`. Output is JSON unless you pass `--text`. Exit code 2 means bad input; 1 means a failure or an id that was not found.

Append `feedbackInstructions` to your server's `instructions` so agents know when to file. If you publish a tool catalog, merge in `feedbackToolCatalog`.

Requires Node 22.13 or later, `@modelcontextprotocol/sdk` 1.x and zod 3.25+ or 4.

### Identity

Each record carries who submitted it, read from the request, never from tool input: subject, client id, scopes, a fingerprint of the access token (not the token), session id, client name and version, user agent. For HTTP servers this depends on your auth middleware setting `req.auth`, which the SDK passes to tools as `authInfo`; without it identity fields are null.

```ts
registerFeedback(server, {
  store,
  requireIdentity: true, // refuse unauthenticated submissions
  resolveIdentity: (extra, defaults) => ({ subject: lookUpUser(extra.authInfo?.token) }),
});
```

### Context

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

### Options

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

### Stores

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

The package does not rate-limit submissions; rely on your server's existing limits.

## Develop

```sh
pnpm install
pnpm test        # unit, end-to-end and store conformance (SQLite, Postgres via PGlite)
docker compose up -d --wait && MCP_FEEDBACK_TEST_POSTGRES_URL=postgres://feedback:feedback@127.0.0.1:54329/feedback pnpm test   # also against a real Postgres
pnpm typecheck
pnpm gen:spec    # regenerate spec/tools.json, store-cases.json and sql/ after changing them in code
pnpm build && pnpm --filter mcp-feedback-example-express smoke   # real HTTP round trip
```

Try the CLI from a local build, exactly as `npx` would run the published package:

```sh
pnpm build && npx --package ./packages/typescript mcp-feedback stats --db ./feedback.db
```

Release from a clean, up-to-date `main`. This bumps the version, runs the checks, publishes to npm, then commits the bump, tags `v<version>` and pushes. If the publish fails, nothing is committed or pushed. Leave out the bump to publish the version already in `package.json`; add `--dry-run` to try it without publishing.

```sh
pnpm release patch --otp=123456    # or minor, major, x.y.z
```
