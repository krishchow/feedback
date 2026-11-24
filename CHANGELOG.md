# Changelog

Versions are those of the `mcp-feedback` npm package. The skills are not versioned separately.

## Unreleased

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
