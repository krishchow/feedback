# Feedback section for an MCP server's own skill

Paste the section below into the skill (or other agent-facing guide) that the MCP server publishes for its users. Then adapt it:

- Replace `<server>` with the server's name, and `submit_feedback` with the real tool name if the server uses a `toolPrefix`.
- Replace the examples under "When to file" with two or three failure modes specific to this server's tools. Concrete examples are what make agents actually file.
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
- `context.repro_steps`, `context.workaround` and `context.suggestion` when you have them.

**What to leave out**

Secrets, credentials, tokens, and personal data about the user or anyone else. Summarise arguments that contain user content instead of pasting them. Do not identify yourself or the user; the server records who called.

**Afterwards**

Tell the user in one line that you filed feedback and what it said. If the tool reports a size limit, shorten the named field and submit again.
