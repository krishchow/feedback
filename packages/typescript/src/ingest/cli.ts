// `mcp-feedback ingest ...`: make keys, issue tokens, and run a hub for one project.

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { FeedbackInputError } from "../reader.js";
import type { FeedbackStore } from "../store.js";
import { createIngestHandler, toNodeListener, type IngestProject } from "./handler.js";
import { generateKeyPair, issueToken, isValidProjectName, type SigningKey } from "./tokens.js";

export const INGEST_USAGE = `mcp-feedback ingest: run a hub that collects feedback from installed copies of a server

Usage: mcp-feedback ingest <command> [options]

Commands:
  keygen --out <file>            Make a signing key. Writes it (private) to <file>; prints the public half
  issue-key --project <p>        Print a project key: ships in the server package, can only enrol
  issue-token --project <p> --subject <s> [--days <n>]
                                 Print a token for a person or team you know (default 90 days)
  serve (--db <path> | --postgres <url>) [--project <p>...] [--port <n>] [--host <h>]
                                 Run the hub (POST /v1/enroll, POST /v1/feedback). Every project
                                 your key issued a project key for goes into one store, under its
                                 own name; --project, repeated, accepts only those listed.
                                 With MCP_FEEDBACK_READER_TOKEN set (32+ characters), also serves
                                 the reader tools for all projects at POST /mcp, behind that token

Options (serve reads each from the environment variable shown when the flag is not given):
  --key <file>      The signing key                       MCP_FEEDBACK_INGEST_KEY (a path, or the key file's JSON)
  --issuer <url>    The hub's public URL; tokens are       MCP_FEEDBACK_INGEST_ISSUER
                    only valid there
  --db <path>       SQLite file                            MCP_FEEDBACK_DB
  --postgres <url>  Postgres connection URL                MCP_FEEDBACK_POSTGRES_URL, then DATABASE_URL
  --table <name>    Table, default mcp_feedback            MCP_FEEDBACK_TABLE
  --project <p>     Accept only these projects (repeat)    MCP_FEEDBACK_INGEST_PROJECTS (comma-separated)
  --port <n>        Default 8787                           PORT
  --host <h>        Default 127.0.0.1                      MCP_FEEDBACK_INGEST_HOST
  --trust-proxy     Client address from X-Forwarded-For    MCP_FEEDBACK_INGEST_TRUST_PROXY=1
  --revoked <file>  Refuse tokens whose jti or subject is  MCP_FEEDBACK_INGEST_REVOKED (comma-separated)
                    a line of this file (read at start)
                    Reader endpoint at /mcp                 MCP_FEEDBACK_READER_TOKEN (32+ characters)
                    HMAC key for token fingerprints        MCP_FEEDBACK_FINGERPRINT_KEY
                    GitHub sign-in: OAuth app client id    MCP_FEEDBACK_GITHUB_CLIENT_ID (device flow enabled)
                    ... only members of these orgs         MCP_FEEDBACK_GITHUB_ORGS (comma-separated)
                    ... only these GitHub logins           MCP_FEEDBACK_GITHUB_USERS (comma-separated)
  --kid <id>        With keygen: the key's id (default: generated)

serve also answers GET /healthz, for container health checks.
`;

interface IngestIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
}

interface KeyFile {
  kid: string;
  privateKey: string;
  publicKey: string;
}

function loadKey(values: Record<string, unknown>, env: IngestIo["env"]): KeyFile {
  const source = (values.key as string | undefined) ?? env.MCP_FEEDBACK_INGEST_KEY;
  if (!source) throw new FeedbackInputError("No signing key. Pass --key <file> or set MCP_FEEDBACK_INGEST_KEY.");
  const text = source.trimStart().startsWith("{") ? source : readFileSync(source, "utf8");
  try {
    const key = JSON.parse(text) as KeyFile;
    if (typeof key.kid === "string" && typeof key.privateKey === "string" && typeof key.publicKey === "string") return key;
  } catch {
    // Falls through to the message below.
  }
  throw new FeedbackInputError("The signing key is not a file written by mcp-feedback ingest keygen.");
}

function required(values: Record<string, unknown>, name: string, envValue?: string): string {
  const value = (values[name] as string | undefined) ?? envValue;
  if (!value) throw new FeedbackInputError(`--${name} is required.`);
  return value;
}

function checkProject(name: string): string {
  if (!isValidProjectName(name)) throw new FeedbackInputError("--project is lowercase letters, digits, ., _ or -, at most 64.");
  return name;
}

/** issue-key and issue-token take exactly one project. */
function project(values: Record<string, unknown>): string {
  const names = (values.project as string[] | undefined) ?? [];
  if (names.length !== 1) throw new FeedbackInputError("Give exactly one --project.");
  return checkProject(names[0]!);
}

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

const digest = (value: string) => createHash("sha256").update(value).digest();
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

/** The reader tools over the hub's store, as a stateless Streamable HTTP MCP endpoint behind one token. */
function readerEndpoint(store: FeedbackStore, token: string, onError: (error: unknown) => void) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (!sameSecret(req.headers.authorization ?? "", `Bearer ${token}`)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const [{ McpServer }, { StreamableHTTPServerTransport }, { registerFeedbackReader }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("../register.js"),
    ]);
    // The SDK hands req.auth to the tools; its clientId is what triage records as triaged_by.
    (req as IncomingMessage & { auth?: unknown }).auth = { token, clientId: "hub-maintainer", scopes: [] };
    const server = new McpServer({ name: "mcp-feedback-hub", version });
    registerFeedbackReader(server, { store, onError: (error) => onError(error) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}

async function openHubStore(values: Record<string, unknown>, env: IngestIo["env"]): Promise<FeedbackStore> {
  const table = (values.table as string | undefined) ?? env.MCP_FEEDBACK_TABLE;
  const db = (values.db as string | undefined) ?? env.MCP_FEEDBACK_DB;
  // DATABASE_URL is what most hosts name the database they attach; the hub is its only user.
  const postgres = (values.postgres as string | undefined) ?? env.MCP_FEEDBACK_POSTGRES_URL ?? env.DATABASE_URL;
  if (db && postgres) throw new FeedbackInputError("Configure one of --db (MCP_FEEDBACK_DB) or --postgres (MCP_FEEDBACK_POSTGRES_URL, DATABASE_URL).");
  if (db) {
    const { sqliteStore } = await import("../stores/sqlite.js");
    return sqliteStore({ path: db, table });
  }
  if (postgres) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: postgres });
    const { postgresStore } = await import("../stores/postgres.js");
    // Unlike the reader commands, the hub creates its table if it is missing.
    return { ...postgresStore({ client: pool, table }), close: () => pool.end() };
  }
  throw new FeedbackInputError("serve needs a store: --db <path> (MCP_FEEDBACK_DB) or --postgres <url> (MCP_FEEDBACK_POSTGRES_URL or DATABASE_URL).");
}

export async function runIngestCli(argv: string[], io: IngestIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        kid: { type: "string" },
        key: { type: "string" },
        issuer: { type: "string" },
        project: { type: "string", multiple: true },
        subject: { type: "string" },
        days: { type: "string" },
        db: { type: "string" },
        postgres: { type: "string" },
        table: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        revoked: { type: "string" },
        "trust-proxy": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new FeedbackInputError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(INGEST_USAGE);
    return command || values.help ? 0 : 2;
  }
  if (rest.length) throw new FeedbackInputError(`ingest ${command} takes no positional arguments.`);
  const issuer = () => required(values, "issuer", io.env.MCP_FEEDBACK_INGEST_ISSUER);
  const signer = (): SigningKey => {
    const key = loadKey(values, io.env);
    return { kid: key.kid, privateKey: key.privateKey };
  };

  switch (command) {
    case "keygen": {
      const out = required(values, "out");
      if (existsSync(out)) throw new FeedbackInputError(`${out} already exists; keygen never overwrites a key.`);
      const key = generateKeyPair(values.kid as string | undefined);
      writeFileSync(out, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      io.err(`Wrote the signing key (kid ${key.kid}) to ${out}. Keep it private; it is never printed again.`);
      io.out(key.publicKey.trimEnd());
      return 0;
    }
    case "issue-key": {
      io.out(issueToken({ issuer: issuer(), project: project(values), tier: "project" }, signer()).token);
      return 0;
    }
    case "issue-token": {
      const days = values.days === undefined ? 90 : Number(values.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new FeedbackInputError("--days must be a whole number from 1 to 3650.");
      const subject = required(values, "subject");
      const { token, claims } = issueToken({ issuer: issuer(), project: project(values), tier: "issued", subject, ttlSeconds: days * 86400 }, signer());
      io.err(`Token for ${subject}, valid until ${new Date(claims.exp! * 1000).toISOString()} (jti ${claims.jti}, for revoking it).`);
      io.out(token);
      return 0;
    }
    case "serve": {
      const key = loadKey(values, io.env);
      const env = io.env;
      const listed = ((values.project as string[] | undefined) ?? (env.MCP_FEEDBACK_INGEST_PROJECTS ?? "").split(","))
        .map((name) => name.trim())
        .filter(Boolean)
        .map(checkProject);
      const readerToken = io.env.MCP_FEEDBACK_READER_TOKEN;
      if (readerToken !== undefined && readerToken.length < 32) {
        throw new FeedbackInputError("MCP_FEEDBACK_READER_TOKEN must be at least 32 characters.");
      }
      const port = Number((values.port as string | undefined) ?? env.PORT ?? 8787);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new FeedbackInputError("--port must be a port number.");
      const revoked = new Set(
        (values.revoked ? readFileSync(values.revoked as string, "utf8").split("\n") : (env.MCP_FEEDBACK_INGEST_REVOKED ?? "").split(","))
          .map((line) => line.trim())
          .filter(Boolean),
      );
      const trustProxy = values["trust-proxy"] === true || /^(1|true|yes)$/i.test(env.MCP_FEEDBACK_INGEST_TRUST_PROXY ?? "");
      const store = await openHubStore(values, env);
      // Opens the store (and creates its table) now, so a bad connection fails at start, not on the first report.
      await store.stats({ since: new Date().toISOString() });
      const logError = (error: unknown) => io.err(`mcp-feedback ingest: ${error instanceof Error ? error.message : String(error)}`);
      const handler = createIngestHandler({
        issuer: issuer(),
        keyring: { keys: [{ kid: key.kid, publicKey: key.publicKey }], signer: { kid: key.kid, privateKey: key.privateKey } },
        store,
        ...(listed.length ? { projects: Object.fromEntries(listed.map((name): [string, IngestProject] => [name, {}])) } : {}),
        isRevoked: (claims) => revoked.has(claims.jti) || revoked.has(claims.sub),
        tokenFingerprintKey: env.MCP_FEEDBACK_FINGERPRINT_KEY,
        ...(env.MCP_FEEDBACK_GITHUB_CLIENT_ID
          ? {
              github: {
                clientId: env.MCP_FEEDBACK_GITHUB_CLIENT_ID,
                allowedOrgs: list(env.MCP_FEEDBACK_GITHUB_ORGS),
                allowedUsers: list(env.MCP_FEEDBACK_GITHUB_USERS),
              },
            }
          : {}),
        onError: logError,
      });
      const ingest = toNodeListener(handler, { trustProxy });
      const reader = readerToken ? readerEndpoint(store, readerToken, logError) : undefined;
      const server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/healthz" && req.method === "GET") res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        else if (reader && path === "/mcp") void reader(req, res).catch(logError);
        else void ingest(req, res);
      });
      const host = (values.host as string | undefined) ?? env.MCP_FEEDBACK_INGEST_HOST ?? "127.0.0.1";
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      const which = listed.length ? listed.join(", ") : "every project the key signed";
      io.err(`mcp-feedback ingest: collecting feedback for ${which} on http://${host}:${bound} (POST /v1/enroll, /v1/feedback)`);
      io.err(reader ? `mcp-feedback ingest: reader tools for all projects at http://${host}:${bound}/mcp` : "mcp-feedback ingest: no reader endpoint (MCP_FEEDBACK_READER_TOKEN is not set)");
      io.err(env.MCP_FEEDBACK_GITHUB_CLIENT_ID ? "mcp-feedback ingest: GitHub sign-in on" : "mcp-feedback ingest: GitHub sign-in off (MCP_FEEDBACK_GITHUB_CLIENT_ID is not set)");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close?.();
      return 0;
    }
    default:
      throw new FeedbackInputError(`Unknown ingest command: ${command}. Run mcp-feedback ingest --help.`);
  }
}
