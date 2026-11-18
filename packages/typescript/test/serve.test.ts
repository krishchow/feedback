import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { memoryStore, type FeedbackStore } from "../src/index.js";
import { conformanceRecords } from "../src/testing.js";
import { READER_TOKEN, readerEndpoint } from "./helpers.js";

const id = (n: number) => conformanceRecords[n - 1]!.id;

async function seeded(): Promise<FeedbackStore> {
  const store = memoryStore();
  for (const record of conformanceRecords) await store.insert(structuredClone(record));
  return store;
}

// The client half of a stdio pipe, using the SDK's own framing, so `serve` runs in-process.
function pipeTransport(toServer: PassThrough, fromServer: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      fromServer.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (let message = buffer.readMessage(); message; message = buffer.readMessage()) transport.onmessage?.(message);
      });
    },
    async send(message: JSONRPCMessage) {
      toServer.write(serializeMessage(message));
    },
    async close() {
      toServer.end();
      transport.onclose?.();
    },
  };
  return transport;
}

async function serve(argv: string[], env: Record<string, string>, store?: FeedbackStore) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const exit = runCli(["serve", ...argv], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { USER: "krish", ...env },
    openStore: store ? async () => store : undefined,
    stdin,
    stdout,
  });
  const client = new Client({ name: "serve-test", version: "1.0.0" });
  await client.connect(pipeTransport(stdin, stdout));
  return {
    client,
    out,
    err,
    stop: async () => {
      await client.close();
      return exit;
    },
  };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const response = await client.callTool({ name, arguments: args });
  return { isError: response.isError === true, data: response.structuredContent as any, text: (response.content as any)[0]?.text };
};

describe("mcp-feedback serve", () => {
  it("serves a store's feedback over stdio, recording the local user as triager", async () => {
    const store = await seeded();
    const session = await serve([], {}, store);
    try {
      expect((await session.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
        "feedback_stats",
        "get_feedback",
        "list_feedback",
        "update_feedback_triage",
      ]);
      expect((await session.client.listPrompts()).prompts.map((p) => p.name)).toEqual(["synthesize_feedback"]);
      expect((await call(session.client, "feedback_stats")).data.total).toBe(6);
      expect((await call(session.client, "list_feedback", { kind: "bug" })).data.items.map((r: any) => r.id)).toEqual([id(6), id(1)]);
      expect(await call(session.client, "get_feedback", { id: "nope" })).toMatchObject({ isError: true, text: "No feedback with id nope." });

      const triaged = await call(session.client, "update_feedback_triage", { ids: [id(2)], status: "resolved", note: "Fixed" });
      expect(triaged.data.updated[0]).toMatchObject({ status: "resolved", triage_note: "Fixed", triaged_by: "krish" });
    } finally {
      expect(await session.stop()).toBe(0);
    }
    // stdout carries only the protocol.
    expect(session.out).toEqual([]);
    expect(session.err.join("\n")).toMatch(/serving the feedback reader tools over stdio/);
  });

  it("leaves out the triage tool with --read-only, and honours --by", async () => {
    const readOnly = await serve(["--read-only"], {}, await seeded());
    try {
      expect((await readOnly.client.listTools()).tools.map((t) => t.name)).not.toContain("update_feedback_triage");
    } finally {
      await readOnly.stop();
    }
    const store = await seeded();
    const named = await serve(["--by", "triage-bot"], {}, store);
    try {
      await call(named.client, "update_feedback_triage", { ids: [id(1)], status: "triaged" });
      expect((await store.get(id(1)))!.triaged_by).toBe("triage-bot");
    } finally {
      await named.stop();
    }
  });

  it("re-serves a remote reader endpoint; the remote server records who triaged", async () => {
    const store = await seeded();
    const endpoint = await readerEndpoint(store, "meme_");
    const session = await serve(["--prefix", "meme_"], { MCP_FEEDBACK_URL: endpoint.url, MCP_FEEDBACK_TOKEN: READER_TOKEN });
    try {
      // Local tool names are unprefixed whatever the remote uses.
      expect((await call(session.client, "feedback_stats")).data).toEqual(await store.stats({}));
      expect(await call(session.client, "get_feedback", { id: "nope" })).toMatchObject({ isError: true, text: "No feedback with id nope." });
      await call(session.client, "update_feedback_triage", { ids: [id(3)], status: "dismissed", note: "Out of scope" });
      expect(await store.get(id(3))).toMatchObject({ status: "dismissed", triaged_by: "reader" });
    } finally {
      await session.stop();
      await endpoint.close();
    }
  });

  it("fails before serving when the source cannot be opened", async () => {
    const endpoint = await readerEndpoint(await seeded());
    try {
      const err: string[] = [];
      const code = await runCli(["serve", "--mcp", endpoint.url], { out: () => {}, err: (l) => err.push(l), env: {} });
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/HTTP 401.*MCP_FEEDBACK_TOKEN is not set/);
      expect(await runCli(["list", "--read-only"], { out: () => {}, err: () => {}, env: {}, openStore: async () => memoryStore() })).toBe(2);
    } finally {
      await endpoint.close();
    }
  });
});
