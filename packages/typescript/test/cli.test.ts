import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { memoryStore, type FeedbackStore } from "../src/index.js";
import { conformanceRecords } from "../src/testing.js";

const id = (n: number) => conformanceRecords[n - 1]!.id;

async function seeded(): Promise<FeedbackStore> {
  const store = memoryStore();
  for (const record of conformanceRecords) await store.insert(structuredClone(record));
  return store;
}

async function cli(store: FeedbackStore | undefined, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { USER: "krish" },
    openStore: store ? async () => store : undefined,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("mcp-feedback CLI", () => {
  it("prints stats as JSON and as text", async () => {
    const store = await seeded();
    expect(JSON.parse((await cli(store, "stats", "--subject", "alice")).out)).toEqual(await store.stats({ subject: "alice" }));
    const text = (await cli(store, "stats", "--text")).out;
    expect(text).toContain("total: 6");
    expect(text).toContain("tool: create_order=3, list_orders=2");
  });

  it("lists with filters and pagination", async () => {
    const store = await seeded();
    const first = JSON.parse((await cli(store, "list", "--limit", "4")).out);
    expect(first.items.map((item: any) => item.id)).toEqual([id(6), id(5), id(4), id(3)]);
    const second = JSON.parse((await cli(store, "list", "--limit", "4", "--cursor", first.next_cursor)).out);
    expect(second.items.map((item: any) => item.id)).toEqual([id(2), id(1)]);
    expect(second.next_cursor).toBeNull();

    const text = (await cli(store, "list", "--tool", "create_order", "--since", "2026-01-02", "--text")).out.split("\n");
    expect(text).toHaveLength(2);
    expect(text[0]).toContain(id(6));
    expect(text[0]).toContain("alice");
  });

  it("exports every match as JSON lines", async () => {
    const lines = (await cli(await seeded(), "export", "--kind", "bug")).out.split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([conformanceRecords[5], conformanceRecords[0]]);
  });

  it("gets one record", async () => {
    const store = await seeded();
    expect(JSON.parse((await cli(store, "get", id(2))).out)).toEqual(conformanceRecords[1]);
    expect((await cli(store, "get", id(2), "--text")).out).toContain("504 after 30s");
    expect(await cli(store, "get", "nope")).toMatchObject({ code: 2, err: "No feedback with id nope." });
  });

  it("closes, dismisses and reopens records", async () => {
    const store = await seeded();
    const closed = await cli(store, "close", id(1), id(6), "--note", "Fixed in 1.2");
    expect(closed.code).toBe(0);
    expect(JSON.parse(closed.out).updated.map((record: any) => record.status)).toEqual(["resolved", "resolved"]);
    expect(await store.get(id(1))).toMatchObject({ status: "resolved", triage_note: "Fixed in 1.2", triaged_by: "krish" });

    await cli(store, "close", id(3), "--dismiss", "--by", "triage-bot");
    expect(await store.get(id(3))).toMatchObject({ status: "dismissed", triaged_by: "triage-bot" });

    await cli(store, "reopen", id(1), "--clear-note");
    expect(await store.get(id(1))).toMatchObject({ status: "new", triage_note: null });

    await cli(store, "triage", id(2), "--status", "triaged");
    expect((await store.stats({})).by_status).toEqual({ new: 3, resolved: 1, dismissed: 1, triaged: 1 });
  });

  it("exits 1 and names ids it could not find", async () => {
    const store = await seeded();
    const result = await cli(store, "close", id(1), "missing");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).not_found).toEqual(["missing"]);
    expect((await store.get(id(1)))!.status).toBe("resolved");
  });

  it("filters by a reference", async () => {
    const store = await seeded();
    const listed = JSON.parse((await cli(store, "list", "--ref", "documentId=doc-1")).out);
    expect(listed.items.map((item: any) => item.id)).toEqual([id(6), id(2)]);
    expect(JSON.parse((await cli(store, "stats", "--ref", "jobId=job-9")).out).total).toBe(1);
    expect(await cli(store, "list", "--ref", "documentId")).toMatchObject({ code: 2, err: expect.stringMatching(/--ref takes key=value/) });
    expect(await cli(store, "list", "--ref", "1bad=x")).toMatchObject({ code: 2, err: expect.stringMatching(/reference key must start/) });
  });

  it("rejects bad input with exit code 2", async () => {
    const store = await seeded();
    expect(await cli(store, "list", "--kind", "rant")).toMatchObject({ code: 2 });
    expect(await cli(store, "list", "--since", "yesterday")).toMatchObject({ code: 2 });
    expect(await cli(store, "list", "--limit", "0")).toMatchObject({ code: 2 });
    expect(await cli(store, "close")).toMatchObject({ code: 2, err: "close needs at least one id." });
    expect(await cli(store, "triage", id(1))).toMatchObject({ code: 2, err: "Provide a status, a note, or both." });
    expect(await cli(store, "frobnicate")).toMatchObject({ code: 2 });
    expect(await cli(store, "list", "--bogus")).toMatchObject({ code: 2 });
    expect(await cli(undefined, "stats")).toMatchObject({ code: 2, err: "No source given. Pass --mcp <url>, --db <path> or --postgres <url>." });
  });

  it("prints usage", async () => {
    expect(await cli(undefined, "--help")).toMatchObject({ code: 0 });
    expect(await cli(undefined)).toMatchObject({ code: 2 });
  });
});
