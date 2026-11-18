import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { connectFeedbackReader, FeedbackReaderError, type FeedbackReaderClient } from "../src/client.js";
import { memoryStore, type FeedbackRecord, type FeedbackStore } from "../src/index.js";
import { READER_TOKEN as TOKEN, readerEndpoint } from "./helpers.js";
import { conformanceCases, conformanceRecords } from "../src/testing.js";

const id = (n: number) => conformanceRecords[n - 1]!.id;

async function seeded(extra = 0): Promise<FeedbackStore> {
  const store = memoryStore();
  for (const record of conformanceRecords) await store.insert(structuredClone(record));
  for (let n = 0; n < extra; n++) {
    const created = new Date(Date.UTC(2025, 0, 1, 0, 0, n)).toISOString();
    await store.insert({ ...structuredClone(conformanceRecords[0]!), id: `bulk-${String(n).padStart(4, "0")}`, created_at: created, updated_at: created });
  }
  return store;
}

describe("feedback reader client", () => {
  let endpoint: Awaited<ReturnType<typeof readerEndpoint>>;
  let store: FeedbackStore;
  let reader: FeedbackReaderClient;

  beforeEach(async () => {
    store = await seeded();
    endpoint = await readerEndpoint(store);
    reader = await connectFeedbackReader({ url: endpoint.url, headers: { Authorization: `Bearer ${TOKEN}` } });
  });
  afterEach(async () => {
    await reader.close();
    await endpoint.close();
  });

  it("answers the store conformance reads exactly as the store does", async () => {
    for (const testCase of conformanceCases) {
      // Later cases read the effects of store-level triage patches, which the tools do not expose.
      if (testCase.op === "update_triage") break;
      if (testCase.op === "list") {
        const pages: string[][] = [];
        let cursor: string | undefined;
        do {
          const page = await reader.list({ ...testCase.filter, limit: testCase.limit, cursor });
          pages.push(page.items.map((item) => item.id));
          cursor = page.next_cursor ?? undefined;
        } while (cursor && pages.length <= testCase.expect_pages.length);
        expect(pages, testCase.name).toEqual(testCase.expect_pages);
      } else if (testCase.op === "stats") {
        expect(await reader.stats(testCase.filter), testCase.name).toEqual(testCase.expect);
      } else if (testCase.op === "get" && testCase.expect_found) {
        expect(await reader.get(testCase.id), testCase.name).toEqual(await store.get(testCase.id));
      }
    }
  });

  it("rejects an unknown id with the server's message", async () => {
    await expect(reader.get("nope")).rejects.toThrow(FeedbackReaderError);
    await expect(reader.get("nope")).rejects.toThrow(/No feedback with id nope/);
  });

  it("triages in one call; the server records who and when", async () => {
    const outcome = await reader.triage([id(1), "nope"], { status: "resolved", note: "Fixed" });
    expect(outcome.not_found).toEqual(["nope"]);
    expect(outcome.updated).toHaveLength(1);
    const record = (await store.get(id(1))) as FeedbackRecord;
    expect(record).toMatchObject({ status: "resolved", triage_note: "Fixed", triaged_by: "reader" });
    expect(record.updated_at > conformanceRecords[0]!.updated_at).toBe(true);
  });

  it("clamps pages to the tool's maximum and continues by cursor", async () => {
    const big = await readerEndpoint(await seeded(150));
    const client = await connectFeedbackReader({ url: big.url, headers: { Authorization: `Bearer ${TOKEN}` } });
    try {
      const first = await client.list({ limit: 1000 });
      expect(first.items).toHaveLength(100);
      expect(first.next_cursor).not.toBeNull();
      const second = await client.list({ limit: 1000, cursor: first.next_cursor! });
      expect(second.items).toHaveLength(56);
      expect(second.next_cursor).toBeNull();
    } finally {
      await client.close();
      await big.close();
    }
  });

  it("fails to connect with a clear message when the credential is wrong", async () => {
    await expect(connectFeedbackReader({ url: endpoint.url, headers: { Authorization: "Bearer wrong" } })).rejects.toThrow(
      /Could not connect to http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
  });
});

describe("mcp-feedback CLI with --mcp", () => {
  const cli = async (env: Record<string, string>, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: { USER: "krish", ...env } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("runs every command against a reader endpoint", async () => {
    const store = await seeded(150);
    const endpoint = await readerEndpoint(store, "meme_");
    const env = { MCP_FEEDBACK_TOKEN: TOKEN };
    const via = ["--mcp", endpoint.url, "--prefix", "meme_"];
    try {
      expect(JSON.parse((await cli(env, "stats", ...via)).out).total).toBe(156);
      const page = JSON.parse((await cli(env, "list", "--limit", "2", "--kind", "bug", ...via)).out);
      expect(page.items.map((r: FeedbackRecord) => r.id)).toEqual([id(6), id(1)]);
      expect((await cli(env, "export", ...via)).out.split("\n")).toHaveLength(156);
      expect(JSON.parse((await cli(env, "get", id(2), ...via)).out)).toEqual(await store.get(id(2)));

      const closed = await cli(env, "close", id(3), "nope", "--note", "Done", "--text", ...via);
      expect(closed.code).toBe(1);
      expect(closed.err).toBe("not found: nope");
      expect(await store.get(id(3))).toMatchObject({ status: "resolved", triage_note: "Done", triaged_by: "reader" });

      const unprefixed = await cli(env, "stats", "--mcp", endpoint.url);
      expect(unprefixed).toMatchObject({ code: 1, err: expect.stringMatching(/Tool feedback_stats not found\. If the server uses a tool prefix, pass it\./) });

      // The URL can also come from the environment.
      expect((await cli({ ...env, MCP_FEEDBACK_URL: endpoint.url }, "reopen", id(3), "--prefix", "meme_")).code).toBe(0);
      expect((await store.get(id(3)))!.status).toBe("new");
    } finally {
      await endpoint.close();
    }
  });

  it("refuses options that do not apply and reports connection failures", async () => {
    const endpoint = await readerEndpoint(await seeded());
    try {
      const env = { MCP_FEEDBACK_TOKEN: TOKEN };
      expect(await cli(env, "close", id(1), "--by", "me", "--mcp", endpoint.url)).toMatchObject({ code: 2, err: expect.stringMatching(/--by does not apply/) });
      expect(await cli(env, "stats", "--db", "x.db", "--mcp", endpoint.url)).toMatchObject({ code: 2 });
      expect(await cli(env, "stats", "--table", "t", "--mcp", endpoint.url)).toMatchObject({ code: 2 });
      expect(await cli({}, "stats", "--prefix", "x_", "--db", ":memory:")).toMatchObject({ code: 2 });
      const unauthorized = await cli({}, "stats", "--mcp", endpoint.url);
      expect(unauthorized.code).toBe(1);
      expect(unauthorized.err).toMatch(/Could not connect to .*: HTTP 401, the credential is missing or was refused\. MCP_FEEDBACK_TOKEN is not set/);
      expect((await cli({ MCP_FEEDBACK_TOKEN: "wrong" }, "stats", "--mcp", endpoint.url)).err).not.toMatch(/is not set/);
      const missing = await cli(env, "stats", "--mcp", endpoint.url.replace(/\/mcp$/, "/nope"));
      expect(missing.err).toMatch(/HTTP 404, no MCP endpoint at this URL/);
    } finally {
      await endpoint.close();
    }
  });
});
