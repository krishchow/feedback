# A project's local feedback reference

The template below becomes the file a project keeps about its own feedback. Sessions load it with the `read-feedback` skill.

- Fill in every `<...>` from what you found, and delete lines and sections that do not apply.
- Mark a fact you could not establish as unknown; do not guess.
- State facts and this project's rules. Leave out how paging, filters, notes, the CLI and `serve` work.
- Name credentials by where they come from. Never write a credential's value.

---

```markdown
---
name: <server>-feedback
description: Where <server>'s agent feedback is read and how this project works through it. Use with the read-feedback skill when asked to review, triage, drain or act on <server> feedback.
---

# <server> feedback

Agents file feedback with `submit_feedback` on `<agent endpoint path>`. Maintainers read and triage it on a separate reader endpoint. Use the `read-feedback` skill for how; this file has what is specific to <server>.

## Where

- Reader endpoint: `https://<published host>/<reader path>`. The <preview or staging> copy at `https://<other host>/<reader path>` keeps separate feedback; read it only when asked about that copy.
- Credential: `<NAME OF THE MAINTAINER SECRET>`, from <where maintainers get it>, supplied as `MCP_FEEDBACK_TOKEN`. `<NAME OF THE AGENT SECRET>` is refused here. Do not ask for, print or store either.
- In this repository, run the CLI as `<pnpm exec mcp-feedback | npx mcp-feedback>`.
- Tool prefix: <none | `<prefix>`>.
- Triage through this endpoint is recorded as `<reader clientId>`.

## Reading a record

- `context.references` keys: `<name>Id` is <what it identifies and which tool returns it>; ...
- `context.server_context` holds <what the server records about those objects when feedback is filed>. <What a timed-out or partial snapshot looks like.>
- `context.metadata`: <keys this server's agents are asked to use, if any>.
- <Whether callers share one credential, and so whether submitters can be told apart.>
- <Whether agents file only after the user confirms.>

## Acting on it

- <Who decides what gets worked on, and whether items are also tracked elsewhere.>
- A fix counts as released when <the project's release step, and the check that it is live>.
- A `resolved` note names <the version, PR, deployment or URL this project uses as evidence>.
- <Anything this project never does with feedback, for example filing it on a user's behalf.>

## Sources

<File and line for the endpoint, the credentials, `contextFields` and `attachContext`, so this can be checked when they change.>
```
