# mcp-feedback

Drop-in feedback for MCP servers. Add one call to a server built on the official MCP SDK and agents get a `submit_feedback` tool; what they report is stamped with the caller's identity and saved to a store you choose. A second set of tools lets a maintainer's agent read and synthesize it.

```sh
npm install mcp-feedback
```

The language-neutral spec (record schema, tool definitions, store contract, SQL layout) and agent skills live in the [repository](https://github.com/krishchow/feedback).

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

## CLI

```sh
mcp-feedback stats --db ./feedback.db
mcp-feedback list --status new --tool create_meme --text
mcp-feedback export --since 2026-11-01 > feedback.jsonl
mcp-feedback get <id> --text
mcp-feedback close <id> <id> --note "Fixed in 1.2"
mcp-feedback close <id> --dismiss --note "Working as intended"
mcp-feedback reopen <id>
```

Use `--postgres <url>` instead of `--db` for Postgres (needs the `pg` package). `MCP_FEEDBACK_DB` and `MCP_FEEDBACK_POSTGRES_URL` set the store from the environment. Output is JSON unless you pass `--text`. Exit code 2 means bad input; 1 means a failure or an id that was not found.

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

## Options

| Option | Purpose |
| --- | --- |
| `store` | Where records go. Required. |
| `resolveIdentity` | Override identity fields for a request. |
| `requireIdentity` | Refuse submissions with no subject and no token fingerprint. |
| `redact` | Scrub a record before it is stored. |
| `limits` | Override size limits (see the spec for defaults). |
| `toolPrefix` | Prefix for tool and prompt names. |
| `serverInfo` | Server name and version to record; defaults to the server's own. |
| `onError` | Receives storage errors, which are hidden from the agent. |

## Stores

| Store | Import | Notes |
| --- | --- | --- |
| SQLite | `mcp-feedback/sqlite` | Default. Uses Node's built-in `node:sqlite`, so there is no native module to install. On Node versions where that module is still experimental, Node prints a warning. |
| Postgres | `mcp-feedback/postgres` | `postgresStore({ client: pool })` with any client that has `query(text, params)`, such as a `pg.Pool`. Pass `migrate: false` if you create the table yourself from `spec/sql/postgres.sql`. |
| Memory | `mcp-feedback` | `memoryStore()`, for tests. |

To write your own, implement `FeedbackStore` and check it with the conformance suite:

```ts
import { defineFeedbackStore } from "mcp-feedback";
import { runStoreConformance } from "mcp-feedback/testing";

const store = defineFeedbackStore({ insert, get, list, updateTriage, stats });
await runStoreConformance(store); // rejects on the first failing case
```

The package does not rate-limit submissions; rely on your server's existing limits.
