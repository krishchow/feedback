# Changelog

Versions are those of the `mcp-feedback` npm package. The skills are not versioned separately.

## Unreleased

- `feedbackEndpoint({ variable, fallback? })` in `mcp-feedback/remote` reads the hub's URL from a server's own variable, then from `MCP_FEEDBACK_ENDPOINT`, so one setting serves every server on a machine; it returns undefined when neither is set or `MCP_FEEDBACK_DISABLED=1`. Servers can then keep their hub's URL out of their repository. `fallback` is a hub the server ships for every installation; a server with one ignores `MCP_FEEDBACK_ENDPOINT`. The add-feedback skill uses it, and `spec/ingest.md` recommends the same order to other implementations.

## 0.8.0 (2026-11-28)

- Open enrolment: a hub with `openEnrollment: true` (`ingest serve --open`, `MCP_FEEDBACK_INGEST_OPEN=1`) lets a server enrol by naming its project, `remoteStore({ endpoint, project })`, so connecting a new server needs nothing from the maintainer. `reservedProjects` keeps names, such as a host server's own, for project keys. A new hub-wide daily quota (`perHubPerDay`, 2000 by default) bounds what anyone naming new projects can add. Hubs say whether they offer it as `open_enrollment` at `/.well-known/mcp-feedback`.

## 0.7.0 (2026-11-26)

- The skills are installed by [agentdist](https://www.npmjs.com/package/agentdist): `mcp-feedback install` puts them into this repository (`--local`) or into every project for you (`--user`), for Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and the other harnesses agentdist supports. `uninstall` removes what it wrote and `status` shows where they are. Its record of what it wrote is `.agentdist/mcp-feedback.json`.
- `mcp-feedback setup` is gone; it now says to run `install --local`. A project set up with it has copies `install` did not write, so it reports them as conflicts: delete the three skill folders and `.mcp-feedback.json` from `.agents/skills` or `.claude/skills` first, or pass `--force`, which backs them up before replacing them.
- The Claude Code and Codex plugin manifests are generated from `agentdist.json`. The Claude Code plugin states a version again, so installed copies update when a release is cut rather than on every commit.
- Feedback from servers that run on their users' machines (stdio servers, CLIs). `mcp-feedback/remote` has `remoteStore()`, a write-only sink that sends each report to the maintainer's ingest hub, enrolling the installation on first use and keeping reports on disk to send later when the hub cannot be reached. `mcp-feedback/ingest` has the hub, `createIngestHandler()`, which verifies Ed25519-signed tokens, stamps identity, project and time itself, applies the same limits as `submit_feedback` plus daily quotas, and writes into any store. `mcp-feedback ingest keygen | issue-key | issue-token | serve` makes keys, issues project keys and per-person tokens, and runs a hub. Protocol in `spec/ingest.md`.
- `registerFeedback` takes any `FeedbackSink` (an object with `insert`) as its `store`. A sink may return a receipt; when a report was queued rather than stored, the tool result says so, with a note for the user. New `destination` option names where reports go in the tool's description. `FeedbackDeliveryError` is shown to the agent as it is.
- One hub for many servers: the hub keeps every project in one store, namespaced by `server.name`, and by default accepts any project its key signed, so a new server needs only a project key. Quotas count within each project. `projects` optionally restricts the list or gives a project its own store. `ingest serve` takes `--project` repeatedly as an allowlist, and with `MCP_FEEDBACK_READER_TOKEN` also serves the reader tools for every project at `/mcp`.
- Stores: a `server` filter (`--server` in the CLI, `server` in the reader tools) and `by_server` in stats. The SQL stores add an index on `server_name` on first use. Custom stores need both to pass the updated conformance cases; until then the reader fills in an empty `by_server`.
- `hub/`: a Dockerfile and deployment notes for running a hub.
- GitHub sign-in: with `signIn: "github"`, `remoteStore` asks its user to sign in once per machine with GitHub's device flow (run by the hub, so GitHub's credential never reaches the user's disk), and reports carry `github:<login>`. The sign-in is a hub-wide `user` token shared by every server on the machine that reports to the same hub. Hubs turn it on with `github: { clientId }` (`MCP_FEEDBACK_GITHUB_CLIENT_ID`), optionally limited to organisations or logins.
- `remoteStore().start()`: call once at startup. It renews stored tokens that are more than a day old (`POST /v1/renew`), so a machine in use keeps its identity indefinitely, then sends queued reports. It contacts the hub only on machines that have used feedback.
- Hubs publish what they offer at `/.well-known/mcp-feedback`.
- `validateSubmission` and `buildRecord` are exported, so other entry points apply exactly the rules `submit_feedback` does.
- `add-feedback-to-mcp-server` skill: starts by working out what kind of server it is. A server distributed to other people that runs on their machines gets the hub path, or a clear stop when there is no hub, instead of a store nobody can read.

## 0.6.0 (2026-11-24)

- `mcp-feedback setup` copies the skills, now shipped in the npm package, into a project's `.agents/skills` or `.claude/skills`. A later run updates files it wrote and keeps ones edited in the project unless `--force` is given.
- New `set-up-feedback-reading` skill: works out a project's own facts (reader endpoint, credential, deployment, reference ids, release rule) from its code and writes them down as a local reference for the sessions that read its feedback.
- `feedbackInstructions`, `feedbackConfirmInstructions` and the `submit_feedback` description now tell agents to give only ids they were given and to submit a report once, not again after an unclear result.
- `read-feedback` skill: a "Working the queue" section for acting on feedback (triaged with a plan, fixed, verified, released, then resolved with evidence); what counts as open; one page against the whole queue; note semantics and CLI exit codes; no deleting or editing records in the store; the `synthesize_feedback` prompt; the limits of the reference filter.
- `read-feedback` connecting reference: which deployment to read, a JSON client configuration for `serve`, and that the client owns a stdio server.
- `add-feedback-to-mcp-server` skill: separate credential and client id for the reader endpoint, an `attachContext` with a timeout, and tests worth adding.
- Feedback section for a server's skill: `context.references`, submitting once, server-owned fields, and wording for `requireConfirmation`.
- The root README now starts from `setup` and the three skills; the package README is the reference and gains the feedback loop, the two-endpoint authentication snippet, reader options, statuses, and CLI paging and notes.
- Example server declares a `contextFields` id and an `attachContext`; the smoke test reads by reference.
- The Claude Code plugin no longer states a version, so installed skills follow the repository.

## 0.5.0 (2026-11-18)

- `mcp-feedback serve`: the reader tools as a stdio MCP server, in front of a reader endpoint or a store.
- `context.references`, with `contextFields` to declare a server's ids and a `reference` filter (`--ref key=value`) to find every report about one object.
- `attachContext`, stored as `context.server_context`.

## 0.4.0 (2026-11-18)

- `requireConfirmation`, with `feedbackConfirmInstructions` and `feedbackToolCatalogFor`, for hosts that file feedback only with the user's consent.
- A blank title or body is rejected.

## 0.3.1 (2026-11-17)

- One-line release script.

## 0.3.0 (2026-11-17)

- Reading through a server's reader endpoint: the CLI's `--mcp`, `MCP_FEEDBACK_URL` and `MCP_FEEDBACK_TOKEN`, and `connectFeedbackReader`.

## 0.2.0 (2026-11-17)

- Postgres timestamps as `TIMESTAMPTZ`, the Drizzle table, and keyed token fingerprints (`tokenFingerprintKey`).
