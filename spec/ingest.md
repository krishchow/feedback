# Ingest: feedback from servers that run on their users' machines

A server agents reach over HTTP keeps feedback in its own store. A server that runs on each user's machine (a stdio server started by `npx`, a CLI) has no store its maintainer can read. Ingest gives it one: installations send reports to a **hub** the maintainer runs, and the hub writes them into an ordinary store (`store-contract.md`) that the reader tools and CLI read as usual.

This part of the specification is optional. An implementation that provides it MUST follow it, so that a client in one language can send to a hub in another.

## Trust

An installed server cannot keep a secret: anything it ships is public. So installations never sign anything. The hub's key signs tokens, and the hub verifies its own signatures. A valid signature therefore proves only that the hub, or the maintainer holding the same key, issued the token, and why it was issued determines how far a report can be trusted:

| Tier | Issued by, to | A valid token proves |
| --- | --- | --- |
| `project` | The maintainer, once per project; ships inside the server package | The request names a project the hub knows. Public, so it proves nothing about the sender. |
| `install` | The hub, to one installation when it enrols | Reports with the same subject come from the same installation. Anonymous. |
| `issued` | The maintainer, to a person or team they know; or the hub, for one project, to a person who signed in | The submitter is the token's subject. |
| `user` | The hub, to a person who signed in (e.g. with GitHub), for every project on the hub | Who signed in. It can only be exchanged for that person's `issued` token for one project, or renewed. |

Feedback content is untrusted in every tier, as everywhere else in this specification. Install-tier reports come from anyone who has the package.

## Tokens

A token is a compact JWT (RFC 7519) signed with Ed25519 (`alg` `EdDSA`).

- The header MUST be `{ "alg": "EdDSA", "typ": "JWT", "kid": <key id> }`. A hub MUST reject a token whose `alg` is anything else, including `none`, and MUST verify with the key named by `kid` only.
- Claims:

  | Claim | Value |
  | --- | --- |
  | `iss` | The hub's identity, usually its public URL. A hub MUST reject a token naming another. |
  | `prj` | The project: lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit, at most 64. `*` for a `user` token, and only for one. |
  | `tier` | `project`, `install`, `issued` or `user`. |
  | `sub` | `project:<prj>` for a project key; `install:<random>` for an install token; `<provider>:<login>` (e.g. `github:octocat`) for a person who signed in; for a token a maintainer issued, the subject they chose (at most 200 characters). |
  | `iat`, `exp` | Seconds since the epoch. `exp` is REQUIRED for every tier but `project`. |
  | `jti` | A unique id (at most 64 characters), so one token can be revoked. |

- A hub SHOULD allow five minutes of clock difference on `iat` and `exp`.
- A hub MAY trust several keys at once, by `kid`, to rotate keys. Keeping the key that signs project keys and issued tokens offline, and a separate key on the hub for install tokens, limits what a compromised hub can mint.

## Endpoints

All but the discovery document take `POST` with a JSON body and, except for open enrolment, a bearer token (`Authorization: Bearer <token>`). Errors are `{ "error": { "code": <string>, "message": <string> } }`; the message MUST be safe to show to an agent and SHOULD say what to do. Paths are relative to the hub's base URL, which may include a path when the hub is mounted inside another application.

### `GET <base>/.well-known/mcp-feedback`

No authentication. What the hub offers:

```json
{
  "issuer": "https://feedback.example.com",
  "endpoints": { "enroll": "/v1/enroll", "feedback": "/v1/feedback", "renew": "/v1/renew" },
  "signin": { "github": { "start": "/v1/signin/github/start", "poll": "/v1/signin/github/poll" } },
  "open_enrollment": false,
  "install_token_ttl_seconds": 2592000,
  "user_token_ttl_seconds": 15552000
}
```

`signin` is `{}` when the hub offers no sign-in, and `user_token_ttl_seconds` is then `null`. `open_enrollment` is `true` when an installation may enrol without a project key (see Projects).

### `POST <base>/v1/enroll`

Bearer: a `project` token, or, on a hub with open enrolment, none, with `"project": <name>` in the body. Body: `{}` for an anonymous installation, or `{ "user_token": <user token> }` for a person who signed in. Returns `201`:

```json
{ "token": "<token>", "subject": "install:…", "tier": "install", "expires_at": "2026-12-26T00:00:00.000Z" }
```

With a valid, unrevoked `user_token`, the token is that person's `issued` token for the project, with the user token's `sub`; otherwise `401` (or `403` if revoked). A hub that has no signing key answers `501` (`not_enrolling`). A hub SHOULD limit anonymous enrolments per network address.

Without a bearer token, a hub that does not offer open enrolment answers `401`. One that does answers `400` for a missing or invalid project name, `403` (`reserved_project`) for a name it keeps for project keys, and `404` for a project it does not collect. When a bearer token is sent, the hub checks it and ignores `project`.

### `POST <base>/v1/renew`

Bearer: an `install` or `user` token that is still valid and not revoked. Body: `{}`. Returns `200` with a new token of the same tier, project and subject and a new expiry, in the same shape as enrolment. A machine that keeps renewing keeps its identity indefinitely; one that stops lets its token expire.

### `POST <base>/v1/signin/github/start` and `…/poll`

Bearer: a `project` token, or none with `"project"` in the body, as for enrolment. The hub runs GitHub's OAuth device flow on the installation's behalf, so GitHub's credential never leaves the hub.

- `start` (body `{}`) returns `{ verification_uri, user_code, expires_in, interval, handle }`. The installation shows the user the URI and code.
- `poll` (body `{ "handle": … }`, no more often than `interval` seconds) answers `202 { "status": "pending" }` (with a larger `interval` when GitHub asks to slow down) until the user acts, then `200` with a `user` token for `github:<login>`, `403` (`signin_denied`, `not_allowed`, `revoked`) or `410` (`signin_expired`).
- The hub requests no GitHub scopes, or `read:org` when it accepts only members of listed organisations, and discards GitHub's token once it has read the login.
- A hub without GitHub sign-in answers `501` (`not_signing_in`).

### `POST <base>/v1/feedback`

Bearer: an `install` or `issued` token. A `project` token MUST be refused. Body, at most 65536 bytes:

| Field | |
| --- | --- |
| `kind`, `title`, `body`, `severity`, `tags`, `context` | The `submit_feedback` input (`tools.json`), validated with the same limits. `context.server_context` is not read from here. |
| `id` | Optional. The installation's id for the report, reused on every retry. |
| `created_at` | Optional. When the installation built the report. |
| `server_context` | Optional. What the installed server's own context hook recorded. Limited like `context.metadata`. |
| `server_version`, `client_name`, `client_version` | Optional. The installed server's version, and the MCP client it saw. |

Returns `201 { id, created_at, status }` for a new report and `200 { id, created_at, status, duplicate: true }` for a retry of one the hub already has.

### Status codes

| Status | Code | Meaning | Client |
| --- | --- | --- | --- |
| 400 | `invalid_request` | The body failed validation. | Do not retry. |
| 401 | `unauthorized` | Missing, malformed, expired or wrong-tier token. | Enrol again once, then give up. |
| 403 | `revoked` | The token was revoked. | Do not retry. |
| 404 | `unknown_project` | The hub does not collect for this project. | Do not retry. |
| 409 | `conflict` | The id belongs to another submitter's report. | Do not retry with that id. |
| 413 | `payload_too_large` | Over the size limit. | Do not retry. |
| 429 | `rate_limited` | A quota is used up. `Retry-After` is set. | Retry later. |
| 5xx | `unavailable` and others | The hub could not store it. | Retry later. |

## Building the record

The hub builds the record exactly as `submit_feedback` does, except that what the server would stamp comes from the token and the hub, never from the body:

| Field | Value |
| --- | --- |
| `id` | The body's `id` if it is a UUIDv7 whose timestamp is within the last 30 days and not in the future, otherwise a new UUIDv7. |
| `created_at`, `updated_at` | When the hub received it. |
| `status` | `new`. |
| `identity.subject` | The token's `sub`. |
| `identity.client_id` | The token's `prj`. |
| `identity.scopes` | `["ingest:<tier>"]`. |
| `identity.token_fingerprint` | As in `SPEC.md`, of the bearer token. |
| `identity.session_id` | `null`. |
| `identity.client_name`, `client_version` | From the body: reported by the installation. |
| `identity.user_agent` | The request's `User-Agent`. |
| `server.name` | The token's `prj`. |
| `server.version` | The body's `server_version`: reported by the installation. |
| `context.server_context` | The body's `server_context`, with the key `ingest` replaced by `{ tier, received_at, client_created_at }`. |

When the record's `id` already exists in the store, the hub MUST store nothing: if the existing record has the same `identity.subject` and `server.name`, it answers `200` as a duplicate, otherwise `409`. Two deliveries of the same report can race; the hub SHOULD treat an insert that fails because the id now exists the same way.

## Projects

A project is a namespace on the hub. One maintainer can run one hub for every server they distribute: each server gets its own project key, and its reports land under its own name.

- A hub SHOULD keep projects in one shared store, with `server.name` as the namespace. Readers then see every project at once, or one with the `server` filter, and `by_server` shows the split.
- By default a hub SHOULD accept any project its keys signed a token for. The signature is the maintainer's authorisation, so a new server needs only a new project key and no change to the hub. A hub MAY instead accept only listed projects, and MAY give a project a store of its own.
- A hub MAY offer **open enrolment**: an installation enrols by naming its project, and a new server needs nothing from the maintainer at all. A project key is public once its package ships, so this gives up little: what it gives up is the maintainer's say over which project names exist. A hub that offers it MUST bound what the whole hub accepts in a day, since anyone can name new projects to escape per-project quotas, and SHOULD keep names that must not be mixed with installations' reports (such as the name a host server files its own feedback under) for project keys. Install tokens from open enrolment are ordinary `install` tokens; listing projects, or revoking subjects, still applies to them.
- A hub MAY serve the reader tools (`SPEC.md`) over its store, behind a maintainer credential that is never an ingest token.

## Quotas

A hub MUST bound how much one token can submit, and SHOULD count within the project, so that one busy project does not use up another's allowance. The reference hub counts records in the store (`stats` with `server`, `subject` and `since`), so its quotas need no other state and hold across processes. Defaults: 20 reports a day per installation, 200 per issued subject, 500 per project, and 2000 across the hub.

When the record's `id` already exists, a retry is recognised only if the existing record has the same `identity.subject` and the same `server.name`.

## The client

A client is a sink: it provides `insert(record)` only, so `registerFeedback` can use it in place of a store.

- It sends to `https`, or to `http` only on the same machine.
- It enrols the first time, with the project key or, on a hub with open enrolment, by naming its project; keeps the install token in a per-user state directory readable only by the user, and enrols again when the hub answers `401`. An issued token, when configured, is used as it is.
- It SHOULD renew its stored tokens when the server starts and they are more than a day old, so a machine in use never has to enrol or sign in again. It MUST NOT contact the hub at start on a machine that holds no token and no queued report.
- With sign-in, it keeps the `user` token where every server on the machine that reports to the same hub can use it, and exchanges it at enrolment for each project. A report filed before the user has signed in waits in the queue, and the tool tells the agent the URI and code to give the user.
- It sends the record's own `id`, so a retry is recognised.
- When the hub cannot be reached, or answers `429` or `5xx`, it MAY keep the report in a local queue and send it later, telling the agent it did so and where the report is waiting. It MUST NOT queue a report the hub refused (`400`, `403`, `404`, `409`, `413`). A queue MUST be bounded in size and age (30 days).
- A host that uses a client MUST honour `MCP_FEEDBACK_DISABLED=1` by not registering the submit tool at all.

When a client is used, the submit tool's description SHOULD say where reports are sent, so the user knows before confirming that the report leaves their machine.
