# Store contract

A store persists feedback records. The tool layer validates input, stamps identity and builds records; the store only saves and queries them. Implement these five operations (named here in snake_case; use your language's convention) and pass `conformance/store-cases.json`.

A store is constructed once by the host and shared by every request. It MUST defer connecting or opening files until its first operation.

## Operations

### `insert(record)`

Persist a complete record (`feedback-record.schema.json`). MUST fail if a record with the same `id` exists. Every field MUST round-trip exactly, including Unicode text, nested `context.metadata` and `null` identity fields.

### `get(id) -> record | null`

### `list(query) -> { items, next_cursor }`

`query` holds the filters below plus `limit` (required, at least 1) and an optional `cursor`.

- Order is `created_at` descending, then `id` descending. Records can share a `created_at`.
- Return at most `limit` records. `next_cursor` is a string when more matching records remain, otherwise `null`.
- Passing `next_cursor` back with the same filters returns the records that follow, with no gaps or repeats, including across a `created_at` tie.
- Cursors are opaque to callers. The bundled stores use base64url of `created_at|id` of the last item returned. A cursor the store cannot read MUST fail.

### `update_triage(id, patch) -> record | null`

`patch` is `{ status?, triage_note?, triaged_by, updated_at }`.

- `triaged_by` and `updated_at` are always written.
- An absent `status` or `triage_note` leaves the stored value unchanged. `triage_note: null` clears the note.
- No other field may change.
- Returns the updated record, or `null` when the id is unknown.

### `stats(filter) -> { total, by_kind, by_status, by_severity, by_tool }`

Counts over the records matching the filter. Each `by_*` map contains only keys with a non-zero count. `by_tool` counts each record once per distinct tool name in its `context.tool_calls`.

## Filters

All filters are optional and combine with AND.

| Filter | Matches when |
| --- | --- |
| `kind`, `status`, `severity` | the field equals the value |
| `subject` | `identity.subject` equals the value |
| `tool` | some entry in `context.tool_calls` has that `name` |
| `tag` | `tags` contains the value |
| `since` | `created_at >= since` |
| `until` | `created_at < until` |
| `reference` | `context.references[reference.key]` equals `reference.value` (the key is validated before it reaches the store) |

Timestamps reach the store already in canonical form (`YYYY-MM-DDTHH:mm:ss.sssZ`), so they compare correctly as strings.

## Conformance vectors

`conformance/store-cases.json` has `records` and `cases`. Start from an empty store, insert the records in any order other than sorted, then run the cases in order; later cases depend on the triage updates made by earlier ones.

| `op` | Check |
| --- | --- |
| `list` | Page through with `filter` and `limit` until `next_cursor` is null; the ids of each page equal `expect_pages`. |
| `get` | Result deep-equals the seeded record with that id, or is null when `expect_found` is false. |
| `stats` | Result deep-equals `expect`. |
| `insert_duplicate` | Inserting the seeded record with that id again fails. |
| `update_triage` | When `expect` is null the result is null. Otherwise the result has every field in `expect`, and `get` returns the same record. |

## SQL layout

`sql/sqlite.sql` and `sql/postgres.sql` define one table, `mcp_feedback` by default. Identity and server fields are flattened into columns. `tags`, `scopes`, `context` and `tool_names` are JSON (`JSONB` in Postgres, JSON text in SQLite). `tool_names` is derived on insert as the distinct `context.tool_calls[].name` values and exists only to make the `tool` filter and `by_tool` counts cheap. Timestamps are `TIMESTAMPTZ(3)` in Postgres and canonical text in SQLite. Millisecond precision means a stored Postgres timestamp reads back as exactly the canonical string that was written, so ordering and cursors behave identically in both. A store MUST return timestamps in the canonical form whatever the column type. Hosts whose schema is managed by Drizzle can use the reference implementation's `mcp-feedback/drizzle` table, which tests keep identical to `sql/postgres.sql`.
