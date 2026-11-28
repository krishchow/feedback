# Feedback from a server that runs on its users' machines

The server sends reports to an ingest hub the maintainer runs; the hub writes them into an ordinary store, read with a reader endpoint or the CLI as for any server. Protocol: `spec/ingest.md` in https://github.com/krishchow/feedback. Do steps 1 to 3 here in place of the main skill's steps 2, 3 and 6.

One hub serves every server a maintainer distributes, each under its own project name. **Ask first whether the maintainer already runs one, and for its URL.** If they do, ask the hub what it needs:

```sh
curl -s <hub URL>/.well-known/mcp-feedback
```

- `"open_enrollment": true`: nothing to issue. Skip step 1 and pass `project: "<project>"` in step 2. The hub needs no change.
- `false`: issue this server a project key with the hub's signing key and issuer (step 1, second command only), then step 2.

`<project>` is lowercase letters, digits, `.`, `_` or `-`, usually the package name. It is the name the maintainer will read this server's reports under, so check it is not one their other servers use.

## 1. Keys and the project key (the maintainer, on their machine)

```sh
npx -y mcp-feedback ingest keygen --out ingest-key.json
npx -y mcp-feedback ingest issue-key --project <project> --key ingest-key.json --issuer <hub URL>
```

- `<hub URL>` is where the hub will be reachable, e.g. `https://feedback.example.com`. Tokens are only valid there, so settle it first.
- `ingest-key.json` is the private signing key. Do not commit it, paste it into chat, or read it into the session. The maintainer stores it in a secret manager and on the hub host. If the maintainer asks you to run `keygen`, write the file outside the repository and tell them where it is.
- The project key `issue-key` prints is public by design: it goes into the server's source. It can only enrol an installation. A new hub with open enrolment (step 3) needs `keygen` only.

## 2. The server

```ts
import { feedbackConfirmInstructions, registerFeedback } from "mcp-feedback";
import { feedbackEndpoint, remoteStore } from "mcp-feedback/remote";

// <SERVER>_FEEDBACK_ENDPOINT, else the shared MCP_FEEDBACK_ENDPOINT; undefined (feedback off) when
// neither is set or MCP_FEEDBACK_DISABLED is.
const endpoint = feedbackEndpoint({ variable: "<SERVER>_FEEDBACK_ENDPOINT" });

if (endpoint) {
  const store = remoteStore({
    endpoint,
    project: "<project>", // on a hub without open enrolment: projectKey: "<the project key>" (public: it can only enrol)
    // signIn: "github", // only for tools used by the maintainer and people they know; see below
    onError: (error) => console.error("feedback:", error), // stderr: stdout carries the protocol
  });
  registerFeedback(server, {
    store,
    requireConfirmation: true,
    destination: "the <server> maintainers",
    attachContext: () => ({ version: "<server version>", platform: process.platform }),
  });
  void store.start(); // renews this machine's token once a day, sends reports queued while the hub was unreachable
}
```

- **Always `requireConfirmation: true`**, with `feedbackConfirmInstructions` in the server's instructions. Reports leave the user's machine; the user sees each one first.
- **`destination`** is added to the tool's description, so the user knows where a report goes before confirming.
- **Where the endpoint comes from: ask the maintainer.** `feedbackEndpoint` keeps the hub's URL out of the repository and out of the package: feedback is on only where someone set `<SERVER>_FEEDBACK_ENDPOINT` (use the server's existing environment prefix) or the shared `MCP_FEEDBACK_ENDPOINT`, which a maintainer sets once for all their servers. Right for an open-source server whose maintainer wants their own and their team's reports. To collect from every installation instead, pass the hub as `fallback`: `feedbackEndpoint({ variable, fallback: "https://feedback.example.com" })` (not `?? "https://…"`, which would ignore `MCP_FEEDBACK_DISABLED`); a server with a fallback ignores the shared variable. Either way, name the server's variable in its environment docs and in any installer's environment passthrough (agentdist `envPassthrough`, Codex `env_vars`), with `MCP_FEEDBACK_ENDPOINT` beside it.
- **`MCP_FEEDBACK_DISABLED=1`** turns feedback off whatever is set (`feedbackEndpoint` returns undefined). Document it in the server's README.
- **`attachContext`** is the place for the server's version and platform. Nothing from the user's files, paths, environment or hostname: it is sent off the machine.
- The installation's token and any queued reports live in a per-user state directory (`~/Library/Application Support/mcp-feedback/<project>` on macOS, `$XDG_STATE_HOME/mcp-feedback/<project>` on Linux). When the hub cannot be reached, the tool result says the report was queued and where, and it is sent on the next start or report. A report the hub refuses is not kept.
- Do not add `resolveIdentity` or `requireIdentity`: the hub stamps identity from each installation's token.
- `start()` contacts the hub only on a machine that has used feedback before, at most once a day. Call it once at startup, not per request.
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
- It accepts every project the key signed, all in one store under their own names. `--open` (`MCP_FEEDBACK_INGEST_OPEN=1`) also lets servers enrol by name with no project key, so later servers need nothing from the maintainer; ask whether they want that. `--project <name>`, repeated, accepts only those.
- To mount it in an existing app instead, use `createIngestHandler` from `mcp-feedback/ingest`; see the package README.

Reading: with `MCP_FEEDBACK_READER_TOKEN` set, the hub serves the reader tools for all projects at `<hub URL>/mcp`. `MCP_FEEDBACK_URL=<hub URL>/mcp MCP_FEEDBACK_TOKEN=… npx -y mcp-feedback stats` shows every project (`by_server`); add `--server <project>` for one. Run `set-up-feedback-reading` afterwards, as the main skill says.

## Anonymous or signed in

Ask which the maintainer wants; do not decide for them.

- **Anonymous (the default, and right for a public package).** Each installation is `install:<random>`: stable per machine, tells the maintainer nothing about who the user is.
- **Signed in with GitHub (`signIn: "github"`)**, for tools used by the maintainer, their team or design partners. The hub must have GitHub sign-in turned on (`MCP_FEEDBACK_GITHUB_CLIENT_ID`; `hub/README.md`). The first report on a machine comes back `queued` with a note telling the user to open github.com/login/device and enter a code; relay it exactly. The report is sent as soon as they approve, the sign-in is shared by every server on the machine using that hub, and `start()` renews it, so it happens once per machine. Reports carry `github:<login>`. Say in the server's README that feedback asks for a GitHub sign-in, and make the `destination` sentence mention it.

Reports from both carry `identity.scopes`: `["ingest:install"]` or `["ingest:issued"]`.

## Verify

- With a local hub (`ingest serve --db /tmp/hub.db --issuer http://127.0.0.1:8787` and a key and project key issued for that issuer), start the server with the endpoint pointed at it, submit one report through a client, and read it back with `mcp-feedback list --db /tmp/hub.db`. Check `server.name` is the project, `identity.scopes` is `["ingest:install"]`, and `context.server_context` has what `attachContext` returned plus `ingest`.
- Stop the hub, submit again, and check the tool result says `queued` with a path. Start the hub and the server again and check the report arrives once.
- `MCP_FEEDBACK_DISABLED=1`: the server lists no `submit_feedback`.
