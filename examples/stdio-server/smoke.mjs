// End to end with real processes: the hub is `mcp-feedback ingest serve`, the server is server.mjs
// over stdio, and the maintainer reads with `mcp-feedback list`. Then the hub goes down, a report is
// queued on the user's machine, and it is delivered once the hub is back. Last, a second server,
// with no project key, enrols by name (open enrolment) and reports to the same hub, and the
// maintainer reads both through the hub's reader endpoint.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../../packages/typescript/dist/cli.js");
const dir = mkdtempSync(join(tmpdir(), "mcp-feedback-stdio-smoke-"));
const keyFile = join(dir, "key.json");
const hubDb = join(dir, "hub.db");
const stateDir = join(dir, "state");
const issuer = "https://feedback.example.com";

const readerToken = "reader-".padEnd(40, "r");
const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const viaReader = (token, ...args) =>
  execFileSync(process.execPath, [cli, ...args, "--mcp", `${endpoint}/mcp`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MCP_FEEDBACK_TOKEN: token },
  }).trim();

const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const endpoint = `http://127.0.0.1:${port}`;

function startHub() {
  const hub = spawn(process.execPath, [cli, "ingest", "serve", "--db", hubDb, "--port", String(port), "--key", keyFile, "--issuer", issuer, "--open"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, MCP_FEEDBACK_READER_TOKEN: readerToken },
  });
  return new Promise((resolve, reject) => {
    hub.stderr.on("data", (chunk) => {
      if (String(chunk).includes("collecting feedback")) resolve(hub);
    });
    hub.once("exit", (code) => reject(new Error(`hub exited with ${code}`)));
  });
}
const stopHub = (hub) => new Promise((resolve) => {
  hub.once("exit", resolve);
  hub.kill("SIGTERM");
});

/** `feedback` is `{ EXAMPLE_PROJECT_KEY }` to enrol with a project key, or `{ EXAMPLE_PROJECT }` to enrol by name. */
async function connectServer(feedback, state = stateDir) {
  const client = new Client({ name: "smoke-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(here, "server.mjs")],
      env: { ...process.env, EXAMPLE_FEEDBACK_ENDPOINT: endpoint, EXAMPLE_STATE_DIR: state, ...feedback },
      stderr: "pipe",
    }),
  );
  return client;
}

const report = (title) => ({ kind: "friction", title, body: "The user wanted the text three times.", context: { tool_calls: [{ name: "echo" }] } });
const list = () => JSON.parse(run("list", "--db", hubDb)).items;

let hub;
try {
  run("ingest", "keygen", "--out", keyFile);
  const projectKey = run("ingest", "issue-key", "--project", "example", "--key", keyFile, "--issuer", issuer);
  hub = await startHub();

  const agent = await connectServer({ EXAMPLE_PROJECT_KEY: projectKey });
  const { tools } = await agent.listTools();
  assert.match(tools.find((tool) => tool.name === "submit_feedback").description, /sent to the example-stdio maintainers/);
  const first = await agent.callTool({ name: "submit_feedback", arguments: report("echo cannot repeat") });
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.equal(first.structuredContent.delivery, undefined);

  const [record] = list();
  assert.equal(record.id, first.structuredContent.id);
  assert.deepEqual(record.server, { name: "example", version: "1.0.0" });
  assert.deepEqual(record.identity.scopes, ["ingest:install"]);
  assert.match(record.identity.subject, /^install:/);
  assert.equal(record.identity.client_name, "smoke-agent");
  assert.equal(record.context.server_context.ingest.tier, "install");
  assert.equal(record.context.server_context.node, process.version);

  await stopHub(hub);
  hub = undefined;
  const second = await agent.callTool({ name: "submit_feedback", arguments: report("queued while the hub was down") });
  assert.equal(second.isError, undefined, JSON.stringify(second));
  assert.equal(second.structuredContent.delivery, "queued");
  assert.equal(readdirSync(join(stateDir, "queue")).length, 1);
  await agent.close();

  // Next start of the server, with the hub back: the queued report goes out on its own.
  hub = await startHub();
  const restarted = await connectServer({ EXAMPLE_PROJECT_KEY: projectKey });
  for (let tries = 0; tries < 50 && readdirSync(join(stateDir, "queue")).length; tries++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readdirSync(join(stateDir, "queue")).length, 0);
  const records = list();
  assert.equal(records.length, 2);
  assert.ok(records.some((item) => item.id === second.structuredContent.id));
  assert.equal(new Set(records.map((item) => item.identity.subject)).size, 1, "both reports come from the same installation");
  await restarted.close();

  // A second server, on another machine, reporting to the same hub under its own project. Nobody
  // issued it anything: it enrols by name.
  const other = await connectServer({ EXAMPLE_PROJECT: "other-server" }, join(dir, "other-machine"));
  assert.equal((await other.callTool({ name: "submit_feedback", arguments: report("from the other server") })).isError, undefined);
  await other.close();

  // One reader endpoint on the hub, for every project.
  const stats = JSON.parse(viaReader(readerToken, "stats"));
  assert.deepEqual(stats.by_server, { example: 2, "other-server": 1 });
  const otherOnly = JSON.parse(viaReader(readerToken, "list", "--server", "other-server")).items;
  assert.deepEqual(otherOnly.map((item) => item.title), ["from the other server"]);
  assert.throws(() => viaReader("wrong-".padEnd(40, "w"), "stats"));
  console.log("stdio smoke test passed");
} finally {
  if (hub) await stopHub(hub);
  rmSync(dir, { recursive: true, force: true });
}
