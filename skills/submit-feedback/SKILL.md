---
name: submit-feedback
description: File feedback about an MCP server's tools with its submit_feedback tool. Use when one of the server's tools fails, returns something unexpected, is confusing to use, or cannot do what the user needed, and when the user asks you to report a problem or request a feature for that server.
---

# Submitting feedback about an MCP server

Servers that expose `submit_feedback` (the name may carry a prefix) want to hear from you when their tools let the user down. The maintainers, or an agent working for them, read these reports later with no access to your session. Write for that reader.

## When to file

- A tool call errored, timed out or returned a wrong or surprising result.
- The user needed something the server's tools could not do.
- A tool worked, but you had to guess at its arguments, retry, or work around it.
- Something worked notably well and is worth keeping that way.

Do not file feedback about problems outside the server: the user's own data, another server, or your own mistake in calling a tool correctly documented.

Finish or get blocked on the user's request first, then file. File one report per distinct problem, not one per failed call.

## What to put in it

- `kind`: `bug`, `tool_failure`, `feature_request`, `friction`, `praise` or `other`.
- `severity`: `blocker` if the user's task could not be completed, `major` if it was completed with real trouble, `minor` otherwise.
- `title`: one line that names the tool and the problem.
- `body`: what happened and why it mattered to the user.
- `context.goal`: what the user was trying to do, in a sentence.
- `context.expected` and `context.actual`.
- `context.tool_calls`: the calls involved, in order, each with a short `arguments_summary` and any `error` text.
- `context.repro_steps` when you know how to trigger it again.
- `context.workaround` if you found one, and `context.suggestion` if you can name a concrete change.

## What to leave out

Never include secrets, credentials, tokens, or personal data about the user or anyone else. Summarise arguments instead of pasting them when they contain user content. You do not identify yourself or the user: the server records who called.

## Afterwards

Tell the user in one line that you filed feedback and what it said. If the tool returns an error about a size limit, shorten the named field and submit again.
