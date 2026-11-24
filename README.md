# mcp-feedback

Drop-in feedback for MCP servers. Add one call to a server built on the official MCP SDK and agents get a `submit_feedback` tool; what they report is stamped with the caller's identity and saved to a store you choose. A second set of tools lets a maintainer's agent read it, work through it and close it out.

## Get started

In the repository of your MCP server:

```sh
npx -y mcp-feedback@latest setup
```

This copies three agent skills into the project's skills directory (`.agents/skills` or `.claude/skills`, whichever it has). Then ask your agent, in order:

| Ask | Skill | What happens |
| --- | --- | --- |
| "Add agent feedback to this MCP server" | `add-feedback-to-mcp-server` | Wires the library into the server (store, identity, a separate reader endpoint) and updates the server's own skills and instructions so agents actually file feedback. |
| "Set this project up for reading its feedback" | `set-up-feedback-reading` | Once per project: finds the reader endpoint, credential, deployment, reference ids and release rule in the code and writes them down, so later sessions do not rediscover them. |
| "Summarize the feedback agents have filed" | `read-feedback` | Reads the queue, groups it into problems worth fixing, and, when asked, works items through to closed. |

Run `setup` again after upgrading: files you have not touched are updated, files you edited are kept unless you pass `--force`. `--dir <path>` installs somewhere else and `--dry-run` shows what would be written.

If the project is worked on only in Claude Code, `setup --plugin` copies nothing and turns the plugin on for the project in `.claude/settings.json` instead. The skills then follow this repository rather than the installed package, and each person runs `claude plugin install mcp-feedback@mcp-feedback --scope project` once in their copy of the project. Other agents get nothing from a plugin, so keep the copy for a project they work in too.

To have the skills in your own sessions in every project instead, install them as a plugin. Claude Code: `/plugin install mcp-feedback --marketplace krishchow/feedback`. Codex reads `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json` from this repo.

## The feedback loop

1. **Collect.** Agents call `submit_feedback` when a tool fails them. Each record starts as `new`.
2. **Read.** A maintainer's agent reads the queue through the reader tools or the `mcp-feedback` CLI and groups it into problems worth fixing.
3. **Work.** Items taken on are marked `triaged` with a note saying what will be done. Triaged means acknowledged and still open.
4. **Close.** Once the fix is released and checked, items are marked `resolved` with the version or PR in the note. What will not be done is `dismissed` with the reason. Either can be reopened.

Nothing is ever deleted, and a record's content and submitter cannot be changed, so the queue is also the history of what agents struggled with and what was done about it.

## By hand

```ts
import { registerFeedback, registerFeedbackReader } from "mcp-feedback";
import { sqliteStore } from "mcp-feedback/sqlite";

const store = sqliteStore({ path: "./feedback.db" }); // once per process

registerFeedback(server, { store });            // on the server agents use
registerFeedbackReader(adminServer, { store }); // on a separate, maintainer-only endpoint
```

```sh
MCP_FEEDBACK_URL=https://example.com/mcp/feedback MCP_FEEDBACK_TOKEN=... npx -y mcp-feedback stats
```

The [package README](packages/typescript/README.md) is the reference: options, identity, context and references, stores, statuses and the CLI. `mcp-feedback --help` lists every command and flag.

## In this repository

- [`packages/typescript/`](packages/typescript/) is the implementation for `@modelcontextprotocol/sdk`, published on npm as [`mcp-feedback`](https://www.npmjs.com/package/mcp-feedback).
- [`skills/`](skills/) holds the three skills above.
- [`spec/`](spec/SPEC.md) is the language-neutral contract: record schema, tool definitions, store contract, conformance vectors, SQL layout. Implement it to support another language.
- [`examples/express-server/`](examples/express-server/) is a runnable stateless HTTP server with both endpoints.
- [`CHANGELOG.md`](CHANGELOG.md) lists what changed in each release.

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
