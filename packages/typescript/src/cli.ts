#!/usr/bin/env node
// Reader CLI: the same operations as the MCP reader tools, either straight
// against the store or through a server's reader endpoint (--mcp). Also `setup`,
// which copies the agent skills into a project.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { FeedbackReaderClient } from "./reader.js";
import { FeedbackInputError, normalizeFilter, storeReader } from "./reader.js";
import type { FeedbackStore } from "./store.js";
import {
  FEEDBACK_KINDS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  type FeedbackFilter,
  type FeedbackRecord,
  type FeedbackStatus,
} from "./types.js";

const USAGE = `mcp-feedback: read and close out feedback collected by an MCP server

Usage: mcp-feedback <command> [options]

Commands:
  stats                 Counts by kind, status, severity and tool
  list                  One page of records, newest first
  export                Every matching record, one JSON object per line
  get <id>              One record
  triage <id...>        Set --status and/or --note
  close <id...>         Mark resolved (or --dismiss), with an optional --note
  reopen <id...>        Set status back to new
  serve                 Serve the reader tools as a stdio MCP server, for agent sessions
                        (stdout carries the protocol; messages go to stderr)
  setup                 Copy the agent skills into this project's skills directory
                        (.agents/skills or .claude/skills, whichever it has); needs no source

Source (one is required):
  --mcp <url>           A server's reader endpoint (or MCP_FEEDBACK_URL). Sends
                        MCP_FEEDBACK_TOKEN from the environment as a bearer token.
  --prefix <p>          The server's tool prefix, if it set one (with --mcp)
  --db <path>           SQLite file              (or MCP_FEEDBACK_DB)
  --postgres <url>      Postgres connection URL  (or MCP_FEEDBACK_POSTGRES_URL)
  --table <name>        Table name, default mcp_feedback (with --db or --postgres)

Filters (stats, list, export):
  --kind <k>  --status <s>  --severity <s>  --subject <s>  --tool <name>  --tag <t>
  --since <iso>  --until <iso>  --ref <key=value> (an id in context.references)

Other:
  --limit <n>           Page size for list (default 25)
  --cursor <c>          next_cursor from a previous list
  --status <s>          For triage: ${FEEDBACK_STATUSES.join(" | ")}
  --note <text>         Triage note
  --clear-note          Remove the triage note
  --dismiss             With close: mark dismissed instead of resolved
  --read-only           With serve: leave out update_feedback_triage
  --dir <path>          With setup: install into this directory instead
  --force               With setup: replace skill files that were changed in the project
  --dry-run             With setup: report what would be written
  --by <name>           Recorded as triaged_by (default: your username; with --mcp
                        the server records the credential's identity instead)
  --text                Human-readable output instead of JSON
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Streams for serve; default to the process's own. */
  stdin?: Readable;
  stdout?: Writable;
  env: Record<string, string | undefined>;
  /** For setup: the directory the project is looked for from; defaults to the process's own. */
  cwd?: string;
  /** Test seam: supply the store instead of opening one from flags. */
  openStore?: () => Promise<FeedbackStore>;
}

async function openStore(values: Record<string, unknown>, env: CliIo["env"]): Promise<FeedbackStore> {
  const table = values.table as string | undefined;
  const db = (values.db as string | undefined) ?? env.MCP_FEEDBACK_DB;
  const postgres = (values.postgres as string | undefined) ?? env.MCP_FEEDBACK_POSTGRES_URL;
  if (db && postgres) throw new FeedbackInputError("Pass one of --mcp, --db or --postgres.");
  if (db) {
    const { sqliteStore } = await import("./stores/sqlite.js");
    return sqliteStore({ path: db, table });
  }
  if (postgres) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: postgres });
    const { postgresStore } = await import("./stores/postgres.js");
    // The CLI reads an existing table; it never creates one.
    return { ...postgresStore({ client: pool, table, migrate: false }), close: () => pool.end() };
  }
  throw new FeedbackInputError("No source given. Pass --mcp <url>, --db <path> or --postgres <url>.");
}

async function openReader(values: Record<string, unknown>, io: CliIo): Promise<FeedbackReaderClient> {
  const by = (values.by as string | undefined) ?? io.env.USER ?? userInfo().username;
  if (io.openStore) return storeReader(await io.openStore(), by);
  const url = (values.mcp as string | undefined) ?? io.env.MCP_FEEDBACK_URL;
  if (!url) {
    if (values.prefix !== undefined) throw new FeedbackInputError("--prefix only applies with --mcp.");
    return storeReader(await openStore(values, io.env), by);
  }
  if (values.db !== undefined || values.postgres !== undefined) throw new FeedbackInputError("Pass one of --mcp, --db or --postgres.");
  if (values.table !== undefined) throw new FeedbackInputError("--table does not apply with --mcp.");
  if (values.by !== undefined) throw new FeedbackInputError("--by does not apply with --mcp: the server records who triaged from the credential.");
  const token = io.env.MCP_FEEDBACK_TOKEN;
  const { connectFeedbackReader, FeedbackReaderError } = await import("./client.js");
  try {
    return await connectFeedbackReader({
      url,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      toolPrefix: values.prefix as string | undefined,
    });
  } catch (error) {
    if (error instanceof FeedbackReaderError && error.status === 401 && !token) {
      throw new FeedbackReaderError(`${error.message} MCP_FEEDBACK_TOKEN is not set; set it to the endpoint's maintainer credential.`, 401);
    }
    throw error;
  }
}

function parseReference(value: string | undefined): FeedbackFilter["reference"] {
  if (value === undefined) return undefined;
  const split = value.indexOf("=");
  if (split <= 0) throw new FeedbackInputError("--ref takes key=value, e.g. --ref orderId=abc.");
  return { key: value.slice(0, split), value: value.slice(split + 1) };
}

function oneOf<T extends string>(label: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new FeedbackInputError(`--${label} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function summaryLine(record: FeedbackRecord): string {
  const who = record.identity.subject ?? record.identity.client_id ?? record.identity.token_fingerprint ?? "anonymous";
  return `${record.id}  ${record.created_at.slice(0, 16)}Z  ${record.status.padEnd(9)} ${record.kind.padEnd(15)} ${record.severity.padEnd(7)} ${who}  ${record.title}`;
}

function detail(record: FeedbackRecord): string {
  const lines = [summaryLine(record), "", record.body];
  for (const [key, value] of Object.entries(record.context)) {
    lines.push("", `${key}:`, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  if (record.tags.length) lines.push("", `tags: ${record.tags.join(", ")}`);
  if (record.triage_note || record.triaged_by) {
    lines.push("", `triage: ${record.triage_note ?? ""} (${record.triaged_by ?? "unknown"}, ${record.updated_at})`);
  }
  return lines.join("\n");
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Serves the reader tools over stdio until the client closes stdin. */
async function serve(reader: FeedbackReaderClient, values: Record<string, unknown>, io: CliIo): Promise<number> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerFeedbackReader } = await import("./register.js");
  const server = new McpServer({ name: "mcp-feedback", version });
  registerFeedbackReader(server, {
    reader,
    readOnly: values["read-only"] === true,
    onError: (error, tool) => io.err(`mcp-feedback: ${tool}: ${error instanceof Error ? error.message : String(error)}`),
  });
  const stdin = io.stdin ?? process.stdin;
  const closed = new Promise<void>((resolve) => {
    stdin.once("end", resolve);
    stdin.once("close", resolve);
  });
  await server.connect(new StdioServerTransport(stdin, io.stdout ?? process.stdout));
  io.err("mcp-feedback: serving the feedback reader tools over stdio");
  await closed;
  await server.close();
  return 0;
}

/** Runs the CLI and resolves the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let reader: FeedbackReaderClient | undefined;
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          mcp: { type: "string" },
          prefix: { type: "string" },
          db: { type: "string" },
          postgres: { type: "string" },
          table: { type: "string" },
          kind: { type: "string" },
          status: { type: "string" },
          severity: { type: "string" },
          subject: { type: "string" },
          tool: { type: "string" },
          tag: { type: "string" },
          since: { type: "string" },
          until: { type: "string" },
          ref: { type: "string" },
          limit: { type: "string" },
          cursor: { type: "string" },
          note: { type: "string" },
          "clear-note": { type: "boolean" },
          dismiss: { type: "boolean" },
          by: { type: "string" },
          text: { type: "boolean" },
          "read-only": { type: "boolean" },
          dir: { type: "string" },
          force: { type: "boolean" },
          "dry-run": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      });
    } catch (error) {
      throw new FeedbackInputError((error as Error).message);
    }
    const { values, positionals } = parsed;
    const [command, ...ids] = positionals;
    if (values.help || !command) {
      io.out(USAGE);
      return command || values.help ? 0 : 2;
    }

    if (values["read-only"] && command !== "serve") throw new FeedbackInputError("--read-only only applies to serve.");
    if (command !== "setup" && (values.dir !== undefined || values.force || values["dry-run"])) {
      throw new FeedbackInputError("--dir, --force and --dry-run only apply to setup.");
    }
    if (command === "setup") {
      if (ids.length) throw new FeedbackInputError("setup takes no arguments; use --dir <path> to choose where.");
      const { setupSkills } = await import("./setup.js");
      return setupSkills({
        cwd: io.cwd ?? process.cwd(),
        dir: values.dir,
        force: values.force,
        dryRun: values["dry-run"],
        version,
        out: io.out,
      });
    }
    const status = oneOf("status", values.status, FEEDBACK_STATUSES);
    const filter: FeedbackFilter = normalizeFilter({
      kind: oneOf("kind", values.kind, FEEDBACK_KINDS),
      status,
      severity: oneOf("severity", values.severity, FEEDBACK_SEVERITIES),
      subject: values.subject,
      tool: values.tool,
      tag: values.tag,
      since: values.since,
      until: values.until,
      reference: parseReference(values.ref),
    });
    const json = (value: unknown) => io.out(JSON.stringify(value, null, 2));
    const needIds = () => {
      if (!ids.length) throw new FeedbackInputError(`${command} needs at least one id.`);
    };
    const open = async () => (reader ??= await openReader(values, io));

    const triage = async (change: { status?: FeedbackStatus; note?: string | null }) => {
      needIds();
      const note = values["clear-note"] ? null : (values.note ?? change.note);
      if (change.status === undefined && note === undefined) throw new FeedbackInputError("Provide a status, a note, or both.");
      const outcome = await (await open()).triage([...new Set(ids)], { status: change.status, note });
      if (values.text) {
        for (const record of outcome.updated) io.out(summaryLine(record));
        for (const id of outcome.not_found) io.err(`not found: ${id}`);
      } else {
        json(outcome);
      }
      return outcome.not_found.length ? 1 : 0;
    };

    switch (command) {
      case "stats": {
        const stats = await (await open()).stats(filter);
        if (!values.text) json(stats);
        else {
          io.out(`total: ${stats.total}`);
          for (const group of ["by_status", "by_kind", "by_severity", "by_tool"] as const) {
            const counts = Object.entries(stats[group]).sort((a, b) => b[1] - a[1]);
            io.out(`${group.slice(3)}: ${counts.map(([key, count]) => `${key}=${count}`).join(", ") || "-"}`);
          }
        }
        return 0;
      }
      case "list": {
        const limit = values.limit === undefined ? undefined : Number(values.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
          throw new FeedbackInputError("--limit must be a whole number from 1 to 1000.");
        }
        const page = await (await open()).list({ ...filter, limit: limit ?? 25, cursor: values.cursor });
        if (!values.text) json(page);
        else {
          page.items.forEach((record) => io.out(summaryLine(record)));
          if (page.next_cursor) io.out(`more: --cursor ${page.next_cursor}`);
        }
        return 0;
      }
      case "export": {
        const source = await open();
        let cursor: string | undefined;
        do {
          const page = await source.list({ ...filter, limit: 200, cursor });
          for (const record of page.items) io.out(values.text ? summaryLine(record) : JSON.stringify(record));
          cursor = page.next_cursor ?? undefined;
        } while (cursor);
        return 0;
      }
      case "get": {
        if (ids.length !== 1) throw new FeedbackInputError("get takes exactly one id.");
        const record = await (await open()).get(ids[0]!);
        if (values.text) io.out(detail(record));
        else json(record);
        return 0;
      }
      case "triage":
        return await triage({ status });
      case "close":
        if (status) throw new FeedbackInputError("close sets the status itself; use triage to set an arbitrary --status.");
        return await triage({ status: values.dismiss ? "dismissed" : "resolved" });
      case "reopen":
        return await triage({ status: "new" });
      case "serve":
        return await serve(await open(), values, io);
      default:
        throw new FeedbackInputError(`Unknown command: ${command}. Run mcp-feedback --help.`);
    }
  } catch (error) {
    if (error instanceof FeedbackInputError) {
      io.err(error.message);
      return 2;
    }
    io.err(`mcp-feedback: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await reader?.close();
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
  });
}
