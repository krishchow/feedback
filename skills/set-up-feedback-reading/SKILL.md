---
name: set-up-feedback-reading
description: Set a project up for reading and acting on the feedback its MCP server collects with mcp-feedback. Finds the project's own facts (the reader endpoint, which credential, which deployment, what the reference ids and server context mean, how the CLI is run here, when a fix counts as released) and writes them down once as a local reference that later sessions read alongside the read-feedback skill. Use when a project already collects feedback and is about to be drained for the first time, when read-feedback found no local reference, when asked to set up, prepare or document feedback reading for a project, or after the server's feedback wiring changed.
---

# Setting a project up to read its feedback

The `read-feedback` skill knows how to read, group and close out feedback for any server. It cannot know one server: where its reader endpoint is, which credential opens it, which deployment holds the real queue, what its reference ids point at. Without that written down, every session that drains the queue works it out again, and some get it wrong.

This skill works those facts out once, from the code, and writes a **local reference**: a short file in the project that later sessions load with `read-feedback`. Do this in the repository of the server whose feedback will be read. If feedback is not collected yet, use `add-feedback-to-mcp-server` first.

## 1. Find the facts in the code

Read them; do not guess, and do not copy an example's values. Note the file and line for each, to cite in the reference.

- **The wiring.** Search for `registerFeedback(` and `registerFeedbackReader(`. From their options: `toolPrefix`, `requireConfirmation`, `readOnly`, `contextFields` (the reference ids and their descriptions), and what `attachContext` returns, including what it returns when it gives up.
- **The reader endpoint.** The route the reader server is mounted on, and the route agents use. If there is no `registerFeedbackReader`, reading is straight from the store: note the store type, the table name if not `mcp_feedback`, and which connection setting reaches it.
- **Credentials, by name.** In the auth middleware: the name of the secret each endpoint checks, and the `clientId` it sets (the reader's is what shows as `triaged_by`). Names only. Never read, print or record a value.
- **Who submitters are.** Whether callers have their own credentials or share one; with a shared one, records cannot tell submitters apart.
- **Deployments.** The published host, and any preview, staging or development copy, from the deployment configuration and docs. Whether each has its own database, and so its own queue.
- **The CLI here.** The installed `mcp-feedback` version and the command that runs it with this project's package manager (`pnpm exec mcp-feedback`, `npx mcp-feedback`, with any workspace filter).
- **Release.** How a change reaches the published server, and what identifies a release (a version, a PR, a deployment id or URL).
- **Where guidance lives.** The directory the project keeps maintainer skills in (`.claude/skills/`, `.agents/skills/`), its `CLAUDE.md` or `AGENTS.md`, and its docs. Look for an existing feedback section or skill to update rather than adding a second.

## 2. Ask for what the code does not say

Ask the user, in one go, only what is still unknown. Usually:

- the published host, if the code does not name it
- where a maintainer gets the reader credential
- when the project counts a fix as released, and what check shows it is live
- whether feedback items are also tracked somewhere else, and who decides what gets worked on
- anything the project never does with feedback

Leave a slot marked unknown rather than filling it with a likely answer.

## 3. Write the local reference

Fill in [references/project-reference.md](references/project-reference.md).

- Put it where the project already keeps maintainer skills, as `<server>-feedback/SKILL.md`. If it keeps none, make it a section of the docs and add one line to `CLAUDE.md` or `AGENTS.md` pointing to it, so sessions find it.
- Facts and this project's rules only. Do not restate how paging, filters, notes, the CLI or `serve` work: `read-feedback` has that and stays current with the package, and a copy here does not.
- Do not write a package version into it.
- If the project already has a feedback skill or section that restates those mechanics, offer to cut it down to the facts.

## 4. Connect

Whether the reader tools are added to the user's sessions is their decision, because it puts a credential within reach of their client. Give them the command, filled in with this project's URL, from the `read-feedback` skill's `references/connecting.md`; do not run it, and do not write the credential into any file.

## 5. Check it

- If `MCP_FEEDBACK_TOKEN` is already set in the environment, run `stats` against the endpoint in the reference and confirm it answers. If it is not, say the endpoint was not checked; do not ask for the credential just to check.
- Confirm the agent endpoint does not list the reader tools, if you can reach it.
- Re-read the reference as a session that has never seen this project: could it find the queue, read a record and know when to mark one resolved, with only this and `read-feedback`?
- Tell the user what was written and where, which facts came from the code, which from them, and which are still unknown.

Run this again when the endpoint, credentials, `contextFields`, `attachContext` or release process change.

If the project should carry these skills itself, so anyone working in it has them without a plugin, `npx -y mcp-feedback@latest install --local` writes them into its agents' skills directories. Suggest it; the user decides whether to commit them.
