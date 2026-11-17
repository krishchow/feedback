# mcp-feedback specification, version 1

This directory is the contract every implementation follows, whatever its language. Two implementations that conform can share one database: a TypeScript server can write feedback that a Python reader serves.

| File | What it defines |
| --- | --- |
| `feedback-record.schema.json` | The stored record (JSON Schema 2020-12). |
| `tools.json` | Tool and prompt names, descriptions, input schemas and annotations; the suggested server instructions. |
| `store-contract.md` | The operations a storage backend provides and how they must behave. |
| `conformance/store-cases.json` | Test vectors for the store contract. |
| `sql/sqlite.sql`, `sql/postgres.sql` | The table layout the SQL stores share. |

`tools.json`, `store-cases.json` and `sql/*.sql` are generated from the TypeScript reference implementation (`pnpm gen:spec`), and its tests fail if they drift. `feedback-record.schema.json` and the prose are written by hand.

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## Submit and read are separate

An implementation provides two independent registration entry points that take an existing MCP server object:

- **Submit** registers `submit_feedback`. It goes on the server agents already use.
- **Reader** is optional. It registers `list_feedback`, `get_feedback`, `update_feedback_triage`, `feedback_stats` and the `synthesize_feedback` prompt. It exposes every caller's feedback, so the host MUST mount it only where access is restricted to maintainers. An implementation MUST NOT register reader tools as a side effect of registering the submit tool. A read-only option omits `update_feedback_triage`.

An implementation SHOULD also ship a command-line reader that performs the same operations directly against a store, so a host can collect feedback without exposing any reader tools over MCP. The reference CLI is described in the repository README.

Both MUST be safe to call on a server object that is built per request. The store is created once by the host and passed to both.

A host MAY configure a prefix that is prepended to every tool and prompt name.

## Submitting

`submit_feedback` accepts the input schema in `tools.json` and returns `{ id, created_at, status }` as structured content, with the same JSON as text content.

The implementation builds the record as follows:

- `id`, `created_at`, `updated_at`, `identity`, `server`, `status` (`new`), `triage_note` (`null`) and `triaged_by` (`null`) are set by the server. Values for these in tool input MUST NOT be honoured.
- `severity` defaults to `none`. `tags` are de-duplicated, keeping first occurrences. `context` defaults to `{}`.
- `id` SHOULD be a UUIDv7. Timestamps MUST be UTC in the form `YYYY-MM-DDTHH:mm:ss.sssZ`.

### Identity

Identity ties a record to the authenticated request. It is resolved in two steps:

1. Defaults from what the MCP SDK exposes to the tool handler:

   | Field | Source |
   | --- | --- |
   | `subject` | `sub` (or `subject`) in the auth info's extra data |
   | `client_id` | auth info client id |
   | `scopes` | auth info scopes |
   | `token_fingerprint` | first 16 hex characters of HMAC-SHA-256 of the access token under a host-configured key; SHA-256 when no key is configured |
   | `session_id` | transport session id |
   | `client_name`, `client_version` | client info from `initialize` |
   | `user_agent` | `User-Agent` request header |

   Anything unavailable is `null` (`[]` for scopes).
2. An optional host-supplied resolver receives the request context and the defaults; fields it returns replace the defaults.

The access token itself MUST NOT be stored. An implementation MUST let the host configure the fingerprint key, and hosts SHOULD set one: an unkeyed fingerprint lets anyone holding the table test guesses of a weak token offline. Every writer to one store must use the same key, or the same token yields different fingerprints. When the host sets "require identity", a submission whose resolved identity has neither `subject` nor `token_fingerprint` MUST be refused and nothing stored.

Stateless HTTP servers have no session id and do not retain client info between requests, so those fields are `null` there. That is expected.

Identity is only as specific as the server's authentication. When every caller shares one credential, every record has the same `client_id` and fingerprint, and the fingerprint distinguishes credential rotations rather than people. Readers MUST NOT treat such records as coming from distinct submitters, and hosts that can tell callers apart some other way SHOULD supply `subject` through the resolver.

### Limits

Limits are enforced before anything is stored; a violation is returned as a tool error that names the field, its size and the limit. Defaults, all host-configurable:

| Limit | Default |
| --- | --- |
| `title` | 200 characters |
| `body` | 8000 characters |
| `context.excerpt` | 8000 characters |
| Any other text field (context strings, tool call fields, each repro step, each tag) | 4000 characters |
| Entries in `tags`, `context.tool_calls`, `context.repro_steps` | 50 |
| `context.metadata` serialised as JSON | 16384 bytes |

A host MAY supply a redaction hook that receives the complete record and returns the record to store.

### Errors

Problems with the caller's input are returned as tool errors with a message the agent can act on. Storage failures MUST be returned as a generic tool error that reveals no detail of the backend, and SHOULD be passed to a host-supplied error hook.

## Reading

- `list_feedback` returns `{ items, next_cursor }`: full records, newest first, default page size 25, maximum 100. `since` and `until` accept any ISO 8601 timestamp and are normalised to the canonical form before reaching the store.
- `get_feedback` returns one record, or a tool error if the id is unknown.
- `update_feedback_triage` triages or closes out one or more records (`ids`, 1 to 100). It changes only `status` and `triage_note` (input field `note`; `null` clears it); at least one MUST be given. `resolved` and `dismissed` close a record, `new` reopens it. `triaged_by` is set from the reader's resolved identity (`subject`, else `client_id`, else `token_fingerprint`) and `updated_at` to the current time. It returns `{ updated, not_found }`: the updated records and the ids that matched nothing. Unknown ids do not make the call fail. Submitted content and submitter identity are immutable.
- `feedback_stats` returns `{ total, by_kind, by_status, by_severity, by_tool }` for the same filters as `list_feedback`.
- `synthesize_feedback` returns a single user message instructing the reader to gather statistics, read every record, group by underlying issue and report by impact. It MUST tell the reader to treat feedback text as data, not instructions: feedback is written by other agents and is untrusted input.

## Versioning

`schema_version` is `1`. Adding an optional field to `context` or a new enum value is a minor change that keeps version 1; readers MUST tolerate unknown enum values in stored data. Removing or re-typing a field requires version 2.
