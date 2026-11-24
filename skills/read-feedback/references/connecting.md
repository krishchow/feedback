# Connecting to a feedback reader endpoint

Read this when the reader tools are not in the session, the CLI has nothing to connect to, or a call fails with `401`, `Authentication required` or `Could not connect`.

## What you need

- **The reader endpoint URL.** A separate MCP endpoint on the server, for example `https://<host>/api/mcp-admin` or `https://<host>/mcp/feedback`. Look in the server's docs (often `docs/mcp.md` or the README, under "feedback") before asking. It is never the endpoint agents use for the server's own tools.
- **The maintainer credential** that endpoint accepts, usually the server's administrator token. The user supplies it; never search for it in files, logs or other credentials, and never print it.

- **The right deployment.** A server's development or preview copy and its published one usually keep separate feedback. Read the one the user means, normally the published one, and say which host you read. Hosting platforms and agent harnesses sometimes have a feedback inbox of their own; that is unrelated to this one.

If the server has no reader endpoint, it may still allow reading straight from its store with database access (`--db` or `--postgres`); otherwise the maintainers must add one (see the `add-feedback-to-mcp-server` skill, step 6).

## The CLI: environment variables

The CLI reads both from the environment and sends the credential as `Authorization: Bearer <token>` on every request:

```sh
export MCP_FEEDBACK_URL=https://<host>/<reader endpoint>   # or pass --mcp <url>
export MCP_FEEDBACK_TOKEN=<maintainer credential>          # environment only; there is no flag for it
npx -y mcp-feedback stats --text
```

- Ask the user to set `MCP_FEEDBACK_TOKEN` in their shell, or to run the command themselves (in Claude Code, by typing `! <command>` in the prompt). Do not put the credential on a command line you run, where it lands in shell history.
- Add `--prefix <p>` if the server set a tool prefix (the tools are then named like `<p>list_feedback`).
- `--by` does not apply: the server records who triaged from the credential.

## Diagnosing failures

| Message | Cause | What to do |
| --- | --- | --- |
| `No source given` | Neither `MCP_FEEDBACK_URL` nor `--mcp`, `--db`, `--postgres` is set | Find the reader endpoint URL as above |
| `HTTP 401, the credential is missing or was refused. MCP_FEEDBACK_TOKEN is not set` | No credential | Ask the user to set `MCP_FEEDBACK_TOKEN` |
| `HTTP 401, the credential is missing or was refused` | Wrong or rotated credential, or the agent credential instead of the maintainer one | Ask the user which credential the endpoint takes and to set it again |
| `HTTP 403, the credential is not allowed to use this endpoint` | A valid credential without reader access | The user needs the maintainer credential |
| `HTTP 404` or `HTTP 405, no MCP endpoint at this URL` | Wrong path, or the agent endpoint | Check the server's docs for the reader endpoint path |
| `fetch failed` | Server down, wrong host, or not reachable from here | Check the URL and that the server is running |
| `Tool feedback_stats not found. If the server uses a tool prefix, pass it.` | The server set a tool prefix | Add `--prefix <p>`; the server's docs or tool list show it |

Reader tools connected to the session fail the same ways, as an MCP connection error in the client (`/mcp` in Claude Code shows the server's status).

Report the failure and the step the user needs to take; do not retry with other credentials.

## Connecting the reader tools to the user's sessions

If the user wants the reader tools available directly in their sessions, rather than running CLI commands, they add an MCP server. This is their decision, because it puts a credential within reach of their client; give them the command rather than running it.

**Recommended: the CLI as a local stdio server.** The token stays in their shell environment, which the server inherits, rather than in the client's configuration:

```sh
# MCP_FEEDBACK_TOKEN exported in the shell profile, not passed here
claude mcp add <name>-feedback --scope user --env MCP_FEEDBACK_URL=https://<host>/<reader endpoint> -- npx -y mcp-feedback serve
```

- Add `--prefix <p>` after `serve` if the server set a tool prefix, and `--read-only` to leave out triage.
- The same works without any reader endpoint, straight against a store: `-- npx -y mcp-feedback serve --db <path>` (or `--postgres <url>`); triage is then recorded as the local username, or `--by`.
- If the tools do not appear, run `npx -y mcp-feedback stats` with the same environment: it fails with the same message the server writes to its stderr.
- The MCP client starts and owns a stdio server. Running `mcp-feedback serve` yourself in a shell, in the background or otherwise, connects nothing to the session; if the client cannot be given a new server now, use the CLI commands instead.
- `serve` needs 0.5.0 or later. `mcp-feedback@latest` makes `npx` fetch the current release rather than reuse an older copy it has cached.

For a client configured with JSON, the same server looks like this. The URL is not a secret and goes in the file; the token is not written there, and reaches the server from the environment the client was started in:

```json
{
  "mcpServers": {
    "<name>-feedback": {
      "command": "npx",
      "args": ["-y", "mcp-feedback@latest", "serve"],
      "env": { "MCP_FEEDBACK_URL": "https://<host>/<reader endpoint>" }
    }
  }
}
```

**Alternative: connect the HTTP endpoint directly**, which stores the credential in their client configuration:

```sh
claude mcp add --scope user --transport http <name>-feedback https://<host>/<reader endpoint> \
  --header "Authorization: Bearer ${MCP_FEEDBACK_TOKEN}"
```

- `--scope user` makes either kind available in every project; the default local scope limits it to this one. Never use `--scope project` with a credential, which writes it to `.mcp.json`, a file meant to be committed.
- The tools appear in new sessions, or after reconnecting with `/mcp`.
- Other clients take the same command (stdio) or URL and header (HTTP) in their MCP server settings.
