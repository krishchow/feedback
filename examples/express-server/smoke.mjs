// End-to-end check over real HTTP: an agent submits feedback, a maintainer reads it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fingerprintToken } from "mcp-feedback";
import { createApp } from "./server.mjs";

const agentToken = "agent-".padEnd(40, "a");
const readerToken = "reader-".padEnd(40, "r");
const dir = mkdtempSync(join(tmpdir(), "mcp-feedback-smoke-"));
const { app, store } = createApp({ agentToken, readerToken, dbPath: join(dir, "feedback.db") });
const listener = app.listen(0);
const base = `http://127.0.0.1:${listener.address().port}`;

async function connect(path, token) {
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + path), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, "User-Agent": "smoke-agent/1.0" } },
    }),
  );
  return client;
}

try {
  const agent = await connect("/mcp", agentToken);
  assert.deepEqual((await agent.listTools()).tools.map((tool) => tool.name).sort(), ["echo", "submit_feedback"]);

  const submitted = await agent.callTool({
    name: "submit_feedback",
    arguments: {
      kind: "friction",
      title: "echo has no way to repeat N times",
      body: "The user asked for the text three times; I had to call echo three times.",
      severity: "minor",
      context: { goal: "Repeat a line three times", tool_calls: [{ name: "echo", arguments_summary: "text=hi" }] },
    },
  });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
  const { id } = submitted.structuredContent;

  // The reader token is rejected on the agent endpoint and vice versa.
  await assert.rejects(connect("/mcp/feedback", agentToken));
  await assert.rejects(connect("/mcp", readerToken));

  const reader = await connect("/mcp/feedback", readerToken);
  const listed = await reader.callTool({ name: "list_feedback", arguments: { tool: "echo" } });
  const [record] = listed.structuredContent.items;
  assert.equal(record.id, id);
  assert.deepEqual(record.server, { name: "example", version: "1.0.0" });
  assert.equal(record.identity.client_id, "example-agent");
  assert.equal(record.identity.token_fingerprint, fingerprintToken(agentToken));
  assert.equal(record.identity.user_agent, "smoke-agent/1.0");
  // Stateless transport: no session id, and client info from initialize is gone by the tool call.
  assert.equal(record.identity.session_id, null);

  const triaged = await reader.callTool({ name: "update_feedback_triage", arguments: { ids: [id], status: "resolved", note: "Added a count argument" } });
  assert.equal(triaged.structuredContent.updated[0].triaged_by, "example-maintainer");

  const stats = await reader.callTool({ name: "feedback_stats", arguments: {} });
  assert.deepEqual(stats.structuredContent.by_status, { resolved: 1 });

  // The CLI reads and reopens the same record straight from the SQLite file.
  const cli = (...args) =>
    JSON.parse(execFileSync("pnpm", ["exec", "mcp-feedback", ...args, "--db", join(dir, "feedback.db")], { encoding: "utf8" }));
  assert.equal(cli("get", id).triage_note, "Added a count argument");
  assert.equal(cli("reopen", id, "--by", "smoke").updated[0].status, "new");
  assert.deepEqual(cli("stats").by_status, { new: 1 });

  console.log("smoke ok:", JSON.stringify(record.identity));
} finally {
  listener.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
}
