---
name: add-feedback-to-mcp-server
description: For maintainers of an MCP server. Integrate the mcp-feedback library so agents can file feedback through a submit_feedback tool, and update the server's own skills, instructions and docs so agents actually use it. Use when asked to add feedback, a feedback tool or agent feedback collection to an MCP server built on @modelcontextprotocol/sdk, to wire up the feedback reader tools or CLI, or to update an MCP server's skill to mention feedback.
---

# Adding mcp-feedback to an MCP server

`mcp-feedback` registers a `submit_feedback` tool on an existing `McpServer`. Records are stamped with the caller's identity and written to a store. Reading and closing out feedback is separate and optional: MCP reader tools, the `mcp-feedback` CLI, or both.

There are two halves to this job. Registering the tool makes feedback possible; telling agents about it (step 5) is what makes it happen. If the tool is already registered, skip to step 5.

The package is TypeScript, for `@modelcontextprotocol/sdk` 1.x on Node 22.13+. For another language, implement `spec/` from https://github.com/krishchow/feedback instead.

## Before editing, find out

1. **Where the `McpServer` is constructed**, and whether that happens once or per request. Either works; registration goes right after construction.
2. **Whether tool handlers receive auth info.** Feedback is tied to the caller through `extra.authInfo`, which the SDK's HTTP transport copies from `req.auth`. If the server's auth middleware does not set `req.auth`, every record will have a null identity. Fix that first (step 2).
3. **What storage the server already has, and whether its disk persists.** Use Postgres if the server has it or runs on ephemeral or multi-instance hosting. Use SQLite for a single long-lived instance or a local stdio server.
4. **Whether the server keeps a hand-written tool list** (a catalog, docs page, or a test asserting the exact tool names). Adding a tool will break those until updated.
5. **What agent-facing guidance the server publishes**: skills (`skills/*/SKILL.md`, a plugin or marketplace in the repo, a skill served by the deployed app), the server `instructions` string, MCP prompts, and tool docs. These all need to mention feedback.

## Steps

### 1. Install

```sh
npm install mcp-feedback
```

The Postgres store takes the pool the server already has; the `pg` dependency is for the CLI.

If the install is refused because the release is too new (pnpm's `minimumReleaseAge`, or a similar policy), ask the user before adding `mcp-feedback` to the exclusion list; do not pin an older version to get around it.

### 2. Make identity available

In the HTTP auth middleware, after the token is verified:

```ts
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

(req as Request & { auth?: AuthInfo }).auth = { token, clientId: "<client or tenant id>", scopes: [], extra: { sub: "<user id if known>" } };
```

Express's `Request` type has no `auth` field, hence the cast. If every caller shares one credential, records cannot tell callers apart: say so in the server's docs, and supply `subject` through `resolveIdentity` if the server knows who is calling some other way.

Stdio servers have no per-request auth; pass `resolveIdentity` to supply a subject (for example from an environment variable) or accept null identity.

### 3. Create the store once

At module level, never inside a request handler. Put it in its own small module (for example `feedback.ts`) that the MCP server imports: test harnesses that stub the database can then swap in `memoryStore()` for that one module.

```ts
import { sqliteStore } from "mcp-feedback/sqlite";
const feedbackStore = sqliteStore({ path: "./feedback.db" });
```

```ts
import { postgresStore } from "mcp-feedback/postgres";
const feedbackStore = postgresStore({ client: pool });
```

Stores open lazily, so this does not touch the database at import. On first use they create their table and indexes if missing (`CREATE ... IF NOT EXISTS`); leave that on. If the project manages its schema with migrations or an ORM, also make the table part of that schema, or a schema-sync tool may try to drop a table it does not know. Keep the store's own creation on as well: schema tools often reach only the development database (Replit's `drizzle-kit push` in `post-merge.sh`, for one), and production then starts without the table. Pass `migrate: false` only when the database user cannot create tables and migrations are known to reach every environment.

- **Drizzle:** export the package's table from the project's schema instead of copying it; tests keep it identical to the store's own DDL, so the two never disagree.

  ```ts
  export { mcpFeedbackTable } from "mcp-feedback/drizzle"; // or feedbackTable("custom_name")
  ```

- **Anything else:** add the DDL from `spec/sql/postgres.sql` as a migration.

### 4. Register the submit tool

```ts
import { registerFeedback, feedbackInstructions, feedbackToolCatalog } from "mcp-feedback";

registerFeedback(server, {
  store: feedbackStore,
  serverInfo: { name: "<server name>", version: "<server version>" },
  tokenFingerprintKey: process.env.FEEDBACK_FINGERPRINT_KEY,
  onError: (error) => logger.warn({ error }, "feedback failed"),
});
```

- `serverInfo` is optional (it defaults to what the server was constructed with), but passing it avoids relying on SDK internals.
- `tokenFingerprintKey` makes token fingerprints an HMAC, so a leaked feedback table cannot be used to test guesses of a weak token. Add it as a server secret, keep it stable, and use the same value on every instance.

- Merge `feedbackToolCatalog` into any hand-written tool list, and update tests that assert tool names.
- Set `requireIdentity: true` if anonymous feedback should be refused.
- Set `requireConfirmation: true` if agents must show the user the exact feedback and get an explicit yes before filing, for example because feedback is shared or the server already asks for consent. Then use `feedbackConfirmInstructions` instead of `feedbackInstructions` (step 5) and `feedbackToolCatalogFor({ requireConfirmation: true })` for catalogs, and say the same in the server's skills.
- Help readers rebuild what happened. List the kinds of objects this server's tools create or act on (whatever they are: orders, documents, jobs, records) and declare the ids that pin a problem down with `contextFields: { <name>Id: "<what it is>" }`; agents then see them in the tool's input and fill them into `context.references`. Readers can pull up every report about one object with `--ref <name>Id=<id>`. If the server can describe the situation better than the agent (its version, a request id, the current state of a referenced object), return that from `attachContext(record, extra)`; it is stored as `context.server_context` and agents cannot forge it. Keep it small and free of secrets and personal data, and do not let a slow lookup hold up the response.
- If the server already has its own feedback tool or table, do not register a second one under the same names: migrate the existing records into the library's store (keeping the old table until the copy is verified), and carry over its policies, such as requiring confirmation.
- Set `toolPrefix` if the server prefixes its tool names.

### 5. Tell agents to use it

Agents rarely call a tool nobody pointed them at. Update every place the server guides them:

- **The server's skills.** In each skill the server publishes for its users, add a feedback section from [references/feedback-section.md](references/feedback-section.md). Replace its generic examples with failure modes specific to this server's tools, and use the real tool name if there is a prefix. If one skill is the entry point and others branch from it, put the full section there and a one-line pointer in the rest. Also add feedback to the skill's `description` only if the skill is meant to trigger on "report a problem with <server>"; otherwise leave the description alone.
- **Workflow steps inside those skills.** Where a skill already describes handling a failure ("if the job times out, retry once"), add "and file feedback" at that point. Guidance at the moment of failure works better than a section at the end.
- **Server `instructions`.** Append `feedbackInstructions` from the package (`feedbackConfirmInstructions` with `requireConfirmation`). This reaches agents that never load the skill.
- **Tool docs and catalog** the server publishes for humans: list `submit_feedback` and say what happens to reports.
- **Version and release.** If the skill ships in a plugin or package with a version, bump it so installed copies update.

If the server publishes no skill, the `instructions` string is enough; do not create a skill just for feedback.

### 6. Choose how feedback is read

Ask the user if they have not said. For a deployed server, recommend a reader endpoint.

- **Reader endpoint (recommended for deployed servers).** Mount `registerFeedbackReader(adminServer, { store: feedbackStore, tokenFingerprintKey })` on a separate MCP endpoint behind a maintainer credential, for example the server's existing admin credential. It exposes every caller's feedback, so never register it on the endpoint ordinary agents connect to. Pass `readOnly: true` to leave out the tool that changes status. Maintainers then need only that URL and credential, never database access, and can either connect it to their agent sessions or drive it with the CLI:

  ```sh
  MCP_FEEDBACK_URL=https://<host>/<reader endpoint> MCP_FEEDBACK_TOKEN=<credential> npx -y mcp-feedback stats
  ```

- **CLI against the store.** Nothing to add to the server; maintainers need database access. `npx -y mcp-feedback stats --db ./feedback.db` or `--postgres "$DATABASE_URL"`, then `list`, `export`, `get`, `close`, `reopen`, `triage`. Suits local and stdio servers.

Document whichever you choose in the server's own docs: the URL or store, where the credential comes from, and the drain loop (`stats`, `list --status new`, `close <ids> --note`).

The people and agents who read it use this plugin's `read-feedback` skill.

### 7. Verify

- List tools with a client and confirm `submit_feedback` is there, and that reader tools are absent from the agent-facing server.
- Submit one record, read it back with the CLI or a reader tool, and check that `identity` has the client id or subject you expect and no raw token.
- Run the server's existing tests.
- Re-read each updated skill as an agent would: is it clear when to file, and is the tool name right?

## Do not

- Create the store per request.
- Accept identity from tool arguments or let the agent pass a user id.
- Put reader tools behind the same credential agents use.
