# Feedback section for an MCP server's own skill

Paste the section below into the skill (or other agent-facing guide) that the MCP server publishes for its users. Then adapt it:

- Replace `<server>` with the server's name, and `submit_feedback` with the real tool name if the server uses a `toolPrefix`.
- Replace the examples under "When to file" with two or three failure modes specific to this server's tools. Concrete examples are what make agents actually file.
- Replace the `context.references` line with the ids the server declared in `contextFields`, each with a few words on where the agent gets it. Remove the line if the server declared none.
- If the server sets `requireConfirmation`, replace "Finish or get blocked..." and the first line of "Afterwards" with the confirmation wording given after the section.
- Keep it short. It sits alongside the skill's real subject and should not crowd it out.

---

## Reporting problems with <server>

This server collects feedback from agents. When its tools let the user down, tell the maintainers with `submit_feedback`. They read these reports later with no access to this session, so write for that reader.

**When to file**

- A tool call errored, timed out or returned a wrong or surprising result.
- The user needed something the tools could not do.
- A tool worked, but you had to guess at its arguments, retry, or work around it.
- Something worked notably well and is worth keeping that way.

Do not file about problems outside this server: the user's own data, another server, or a call you made incorrectly against a clearly documented tool.

Finish or get blocked on the user's request first, then file. File one report per distinct problem, not one per failed call.

**What to include**

- `kind`: `bug`, `tool_failure`, `feature_request`, `friction`, `praise` or `other`.
- `severity`: `blocker` if the user's task could not be completed, `major` if it was completed with real trouble, `minor` otherwise.
- `title`: one line naming the tool and the problem.
- `body`: what happened and why it mattered to the user.
- `context.goal`, `context.expected`, `context.actual`.
- `context.tool_calls`: the calls involved, in order, each with a short `arguments_summary` and any `error` text.
- `context.references`: the ids of the objects involved, for example `{ "<name>Id": "..." }`. Include every one you have; maintainers use them to find the objects and every other report about them. Leave out an id you do not have rather than guessing one.
- `context.repro_steps`, `context.workaround` and `context.suggestion` when you have them.

**What to leave out**

Secrets, credentials, tokens, and personal data about the user or anyone else. Summarise arguments that contain user content instead of pasting them. Do not identify yourself or the user, and do not fill in `context.server_context`; the server records who called and what it knew at the time.

**Afterwards**

Tell the user in one line that you filed feedback and what it said. If the tool reports a size limit, shorten the named field and submit again. Otherwise submit once: a second call files a second report, so if a call timed out and you cannot tell whether it went through, say so instead of sending it again. Keep the `id` that comes back, in case the user wants to refer to the report. This connection cannot read reports or their status; maintainers do that elsewhere, so do not ask for their credentials to check on one.

---

## With `requireConfirmation`

In place of "Finish or get blocked on the user's request first, then file.":

> Finish or get blocked on the user's request first. Then show the user the exact report you would file (kind, severity, title, body and context) and ask whether to submit it. File only after an explicit yes to that report; a complaint, a request for help or silence is not a yes. If they change it, show the new version and ask again.

In place of "Tell the user in one line that you filed feedback and what it said.":

> Tell the user it was filed.
