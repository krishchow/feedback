# mcp-feedback

Drop-in feedback for MCP servers. Add one call to a server built on the official MCP SDK and agents get a `submit_feedback` tool; what they report is stamped with the caller's identity and saved to a store you choose. A second set of tools lets a maintainer's agent read and synthesize it.

- `spec/` is the language-neutral contract: record schema, tool definitions, store contract, conformance vectors, SQL layout. Start at [`spec/SPEC.md`](spec/SPEC.md).
- `packages/typescript/` is the reference implementation for `@modelcontextprotocol/sdk` (npm name `mcp-feedback`, not yet published).
- `skills/` holds agent skills for filing and for synthesizing feedback.
- `examples/express-server/` is a runnable stateless HTTP server using both tool sets.

## Use (TypeScript)

```ts
import { registerFeedback, registerFeedbackReader, feedbackInstructions } from "mcp-feedback";
import { sqliteStore } from "mcp-feedback/sqlite";

const store = sqliteStore({ path: "./feedback.db" }); // once per process

// On the server agents use:
registerFeedback(server, { store });

// On a separate, maintainer-only server or endpoint:
registerFeedbackReader(adminServer, { store });
```

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

### Options

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

### Stores

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

## Develop

```sh
pnpm install
pnpm test        # unit, end-to-end and store conformance (SQLite, Postgres via PGlite)
pnpm typecheck
pnpm gen:spec    # regenerate spec/tools.json, store-cases.json and sql/ after changing them in code
pnpm build && pnpm --filter mcp-feedback-example-express smoke   # real HTTP round trip
```
