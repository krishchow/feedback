# Feedback from a server that runs on its users' machines

The server sends reports to an ingest hub the maintainer runs; the hub writes them into an ordinary store, read with a reader endpoint or the CLI as for any server. Protocol: `spec/ingest.md` in https://github.com/krishchow/feedback. Do steps 1 to 3 here in place of the main skill's steps 2, 3 and 6.

One hub serves every server a maintainer distributes, each under its own project name. **Ask first whether the maintainer already runs one.** If they do, skip to issuing a project key for this server with the same signing key and issuer (step 1, second command only), then step 2; the hub needs no change.

## 1. Keys and the project key (the maintainer, on their machine)

```sh
npx -y mcp-feedback ingest keygen --out ingest-key.json
npx -y mcp-feedback ingest issue-key --project <project> --key ingest-key.json --issuer <hub URL>
```

- `<project>` is lowercase letters, digits, `.`, `_` or `-`, usually the package name.
- `<hub URL>` is where the hub will be reachable, e.g. `https://feedback.example.com`. Tokens are only valid there, so settle it first.
- `ingest-key.json` is the private signing key. Do not commit it, paste it into chat, or read it into the session. The maintainer stores it in a secret manager and on the hub host. If the maintainer asks you to run `keygen`, write the file outside the repository and tell them where it is.
- The project key it prints is public by design: it goes into the server's source. It can only enrol an installation.

## 2. The server

```ts
import { feedbackConfirmInstructions, registerFeedback } from "mcp-feedback";
import { feedbackDisabled, remoteStore } from "mcp-feedback/remote";

const FEEDBACK_ENDPOINT = "https://feedback.example.com";
const FEEDBACK_PROJECT_KEY = "<the project key>"; // public: it can only enrol an installation

if (!feedbackDisabled()) {
  const store = remoteStore({
    endpoint: FEEDBACK_ENDPOINT,
    projectKey: FEEDBACK_PROJECT_KEY,
    token: process.env.<SERVER>_FEEDBACK_TOKEN, // optional: an issued token, for users the maintainer knows
    onError: (error) => console.error("feedback:", error), // stderr: stdout carries the protocol
  });
  registerFeedback(server, {
    store,
    requireConfirmation: true,
    destination: "the <server> maintainers",
    attachContext: () => ({ version: "<server version>", platform: process.platform }),
  });
  void store.flush(); // sends reports queued while the hub was unreachable
}
```

- **Always `requireConfirmation: true`**, with `feedbackConfirmInstructions` in the server's instructions. Reports leave the user's machine; the user sees each one first.
- **`destination`** is added to the tool's description, so the user knows where a report goes before confirming.
- **`feedbackDisabled()`** reads `MCP_FEEDBACK_DISABLED`. Document it in the server's README as the way to turn feedback off.
- **`attachContext`** is the place for the server's version and platform. Nothing from the user's files, paths, environment or hostname: it is sent off the machine.
- The installation's token and any queued reports live in a per-user state directory (`~/Library/Application Support/mcp-feedback/<project>` on macOS, `$XDG_STATE_HOME/mcp-feedback/<project>` on Linux). When the hub cannot be reached, the tool result says the report was queued and where, and it is sent on the next start or report. A report the hub refuses is not kept.
- Do not add `resolveIdentity` or `requireIdentity`: the hub stamps identity from each installation's token.
- Tests: use `memoryStore()` in place of `remoteStore` where tests build the server, as for any store.

## 3. The hub (the maintainer's host)

Only the first time; later servers reuse it. If the maintainer already hosts an HTTP MCP server or web app, the hub can be mounted inside it, using that app's store and reader endpoint ("No separate host?" in the package README). Otherwise the easiest path is the container in `hub/` of https://github.com/krishchow/feedback, whose README lists what to configure. Or on any Node host:

```sh
MCP_FEEDBACK_INGEST_KEY=/secure/ingest-key.json MCP_FEEDBACK_READER_TOKEN=<32+ random characters> \
  npx -y mcp-feedback ingest serve --postgres "$DATABASE_URL" --issuer <hub URL> --port 8787 --host 0.0.0.0 --trust-proxy
```

- `--trust-proxy` only behind a proxy that overwrites `X-Forwarded-For`; it is how enrolments are limited per address.
- `--revoked <file>` lists token ids (`jti`) or subjects to refuse, one per line, read at start.
- TLS is the host's or proxy's job; installations refuse plain `http` to anything but localhost.
- It accepts every project the key signed, all in one store under their own names. `--project <name>`, repeated, accepts only those.
- To mount it in an existing app instead, use `createIngestHandler` from `mcp-feedback/ingest`; see the package README.

Reading: with `MCP_FEEDBACK_READER_TOKEN` set, the hub serves the reader tools for all projects at `<hub URL>/mcp`. `MCP_FEEDBACK_URL=<hub URL>/mcp MCP_FEEDBACK_TOKEN=… npx -y mcp-feedback stats` shows every project (`by_server`); add `--server <project>` for one. Run `set-up-feedback-reading` afterwards, as the main skill says.

## Issued tokens

For a person or team the maintainer knows (a design partner, an internal team), issue a token and deliver it privately; they set it in the environment variable the server reads:

```sh
npx -y mcp-feedback ingest issue-token --project <project> --subject <who> --days 90 --key ingest-key.json --issuer <hub URL>
```

Their reports carry `identity.subject` = `<who>` and `identity.scopes` = `["ingest:issued"]`. Everyone else's are `ingest:install`: anonymous, one subject per installation.

## Verify

- With a local hub (`ingest serve --db /tmp/hub.db --issuer http://127.0.0.1:8787` and a key and project key issued for that issuer), start the server with the endpoint pointed at it, submit one report through a client, and read it back with `mcp-feedback list --db /tmp/hub.db`. Check `server.name` is the project, `identity.scopes` is `["ingest:install"]`, and `context.server_context` has what `attachContext` returned plus `ingest`.
- Stop the hub, submit again, and check the tool result says `queued` with a path. Start the hub and the server again and check the report arrives once.
- `MCP_FEEDBACK_DISABLED=1`: the server lists no `submit_feedback`.
