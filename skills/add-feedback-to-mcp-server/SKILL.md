---
name: add-feedback-to-mcp-server
description: Integrate the mcp-feedback library into an MCP server so agents can file feedback through a submit_feedback tool. Use when asked to add feedback, a feedback tool, or agent feedback collection to an MCP server built on @modelcontextprotocol/sdk, or to wire up the feedback reader tools or CLI.
---

# Adding mcp-feedback to an MCP server

`mcp-feedback` registers a `submit_feedback` tool on an existing `McpServer`. Records are stamped with the caller's identity and written to a store. Reading and closing out feedback is separate and optional: MCP reader tools, the `mcp-feedback` CLI, or both.

The package is TypeScript, for `@modelcontextprotocol/sdk` 1.x on Node 22.13+. For another language, implement `spec/` from https://github.com/krishchow/feedback instead.

## Before editing, find out

1. **Where the `McpServer` is constructed**, and whether that happens once or per request. Either works; registration goes right after construction.
2. **Whether tool handlers receive auth info.** Feedback is tied to the caller through `extra.authInfo`, which the SDK's HTTP transport copies from `req.auth`. If the server's auth middleware does not set `req.auth`, every record will have a null identity. Fix that first (step 2).
3. **What storage the server already has, and whether its disk persists.** Use Postgres if the server has it or runs on ephemeral or multi-instance hosting. Use SQLite for a single long-lived instance or a local stdio server.
4. **Whether the server keeps a hand-written tool list** (a catalog, docs page, or a test asserting the exact tool names). Adding a tool will break those until updated.

## Steps

### 1. Install

```sh
npm install mcp-feedback
```

`pg` is needed only for the CLI's `--postgres` flag; the Postgres store itself takes the pool the server already has.

### 2. Make identity available

In the HTTP auth middleware, after the token is verified:

```ts
req.auth = { token, clientId: "<client or tenant id>", scopes: [], extra: { sub: "<user id if known>" } };
```

Stdio servers have no per-request auth; pass `resolveIdentity` to supply a subject (for example from an environment variable) or accept null identity.

### 3. Create the store once

At module level, never inside a request handler:

```ts
import { sqliteStore } from "mcp-feedback/sqlite";
const feedbackStore = sqliteStore({ path: "./feedback.db" });
```

```ts
import { postgresStore } from "mcp-feedback/postgres";
const feedbackStore = postgresStore({ client: pool });
```

Stores open lazily, so this does not touch the database at import. If the project manages its schema with migrations or an ORM, add the table from `spec/sql/postgres.sql` there and pass `migrate: false`; otherwise a schema-sync tool may try to drop a table it does not know.

### 4. Register the submit tool

```ts
import { registerFeedback, feedbackInstructions, feedbackToolCatalog } from "mcp-feedback";

registerFeedback(server, { store: feedbackStore, onError: (error) => logger.warn({ error }, "feedback failed") });
```

- Append `feedbackInstructions` to the server's `instructions` so agents know when to file.
- Merge `feedbackToolCatalog` into any hand-written tool list, and update tests that assert tool names.
- Set `requireIdentity: true` if anonymous feedback should be refused.
- Set `toolPrefix` if the server prefixes its tool names.

### 5. Choose how feedback is read

Ask the user if they have not said. The options combine.

- **CLI only.** Nothing more to add to the server. Maintainers run `npx mcp-feedback stats --db ./feedback.db` (or `--postgres "$DATABASE_URL"`), and `list`, `export`, `get`, `close`, `reopen`, `triage`.
- **MCP reader tools.** Mount `registerFeedbackReader(adminServer, { store: feedbackStore })` on a separate endpoint with its own credential. It exposes every caller's feedback, so never register it on the server ordinary agents connect to. Pass `readOnly: true` to leave out the tool that changes status.

### 6. Verify

- List tools with a client and confirm `submit_feedback` is there, and that reader tools are absent from the agent-facing server.
- Submit one record, read it back with the CLI or a reader tool, and check that `identity` has the client id or subject you expect and no raw token.
- Run the server's existing tests.

## Do not

- Create the store per request.
- Accept identity from tool arguments or let the agent pass a user id.
- Put reader tools behind the same credential agents use.
