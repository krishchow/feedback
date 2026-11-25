import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecord, FeedbackDeliveryError, registerFeedback, registerFeedbackReader, type FeedbackRecord } from "../src/index.js";
import { feedbackDisabled, remoteStore, type RemoteStoreOptions } from "../src/remote.js";
import { call, connect } from "./helpers.js";
import { startHub } from "./ingest-helpers.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
let hub: Hub | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-feedback-remote-"));
  dirs.push(dir);
  return dir;
}

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  const built = buildRecord(
    { kind: "bug", title: "It broke", body: "do_thing failed." },
    {
      identity: { subject: null, client_id: null, session_id: null, token_fingerprint: null, scopes: [], client_name: "claude-code", client_version: "2.0.0", user_agent: null },
      server: { name: "acme-mcp", version: "1.4.0" },
    },
  );
  return { ...built, ...overrides };
}

/** A fetch that counts calls by path. */
function counting() {
  const calls: string[] = [];
  const wrapped: typeof fetch = (input, init) => {
    calls.push(new URL(String(input)).pathname);
    return fetch(input, init);
  };
  return { calls, fetch: wrapped };
}

function store(h: Hub, options: Partial<RemoteStoreOptions> = {}) {
  return remoteStore({ endpoint: h.url, projectKey: h.projectKey, stateDir: stateDir(), ...options });
}

describe("remoteStore", () => {
  it("enrols once, caches the token, and delivers", async () => {
    hub = await startHub();
    const { calls, fetch } = counting();
    const dir = stateDir();
    const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir, fetch });
    const first = record();
    expect(await sink.insert(first)).toEqual({ delivery: "stored" });
    expect(await sink.insert(record())).toEqual({ delivery: "stored" });
    expect(calls.filter((path) => path === "/v1/enroll")).toHaveLength(1);
    expect(statSync(join(dir, "token.json")).mode & 0o777).toBe(0o600);

    // A second process with the same state directory reuses the token.
    const again = counting();
    await remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir, fetch: again.fetch }).insert(record());
    expect(again.calls).not.toContain("/v1/enroll");

    const stored = (await hub.store.get(first.id))!;
    expect(stored.identity.scopes).toEqual(["ingest:install"]);
    expect(stored.server).toEqual({ name: "acme", version: "1.4.0" });
    expect(stored.identity.client_name).toBe("claude-code");
  });

  it("enrols again when the hub no longer accepts the cached token", async () => {
    hub = await startHub();
    const dir = stateDir();
    writeFileSync(join(dir, "token.json"), JSON.stringify({ endpoint: hub.url, token: "a.b.c", expires_at: new Date(Date.now() + 9e9).toISOString() }));
    const { calls, fetch } = counting();
    const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir, fetch });
    expect(await sink.insert(record())).toEqual({ delivery: "stored" });
    expect(calls).toEqual(["/v1/feedback", "/v1/enroll", "/v1/feedback"]);
  });

  it("sends with an issued token without enrolling", async () => {
    hub = await startHub();
    const { calls, fetch } = counting();
    const sink = remoteStore({ endpoint: hub.url, token: hub.issue("alice"), stateDir: stateDir(), fetch });
    const sent = record();
    await sink.insert(sent);
    expect(calls).toEqual(["/v1/feedback"]);
    expect((await hub.store.get(sent.id))!.identity).toMatchObject({ subject: "alice", scopes: ["ingest:issued"] });
  });

  it("queues a report when the hub is down and delivers it exactly once later", async () => {
    hub = await startHub();
    const dir = stateDir();
    const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir });
    await sink.insert(record());
    hub.setUp(false);
    const waiting = record();
    const receipt = await sink.insert(waiting);
    expect(receipt).toMatchObject({ delivery: "queued", note: expect.stringContaining(join(dir, "queue", `${waiting.id}.json`)) });
    expect(statSync(join(dir, "queue", `${waiting.id}.json`)).mode & 0o777).toBe(0o600);

    hub.setUp(true);
    expect(await sink.flush()).toEqual({ delivered: 1, dropped: 0, remaining: 0 });
    expect(await sink.flush()).toEqual({ delivered: 0, dropped: 0, remaining: 0 });
    expect(readdirSync(join(dir, "queue"))).toEqual([]);
    expect((await hub.store.get(waiting.id))!.id).toBe(waiting.id);
    expect((await hub.store.stats({})).total).toBe(2);
  });

  it("queues when the hub cannot be reached at all, without trying twice", async () => {
    hub = await startHub();
    const projectKey = hub.projectKey;
    const url = hub.url;
    await hub.close();
    hub = undefined;
    const { calls, fetch } = counting();
    const sink = remoteStore({ endpoint: url, projectKey, stateDir: stateDir(), fetch });
    expect((await sink.insert(record())).delivery).toBe("queued");
    calls.length = 0;
    // The queue's first report fails, so the new one is queued behind it with no further attempt.
    expect((await sink.insert(record())).delivery).toBe("queued");
    expect(calls).toEqual(["/v1/enroll"]);
  });

  it("does not queue a report the hub refuses", async () => {
    hub = await startHub();
    const dir = stateDir();
    const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir });
    await expect(sink.insert(record({ title: "x".repeat(201) }))).rejects.toThrow(FeedbackDeliveryError);
    await expect(sink.insert(record({ title: "x".repeat(201) }))).rejects.toThrow(/the limit is 200/);
    expect(() => readdirSync(join(dir, "queue"))).toThrow();
  });

  it("bounds the queue, drops expired reports, and can be turned off", async () => {
    hub = await startHub();
    hub.setUp(false);
    const dir = stateDir();
    const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKey, stateDir: dir, queue: { maxItems: 2 } });
    await sink.insert(record());
    await sink.insert(record());
    await expect(sink.insert(record())).rejects.toThrow(/2 earlier reports are already waiting/);

    const stale = record();
    writeFileSync(
      join(dir, "queue", `0-${stale.id}.json`),
      JSON.stringify({ queued_at: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(), submission: { kind: "bug", title: "t", body: "b" } }),
    );
    hub.setUp(true);
    expect(await sink.flush()).toEqual({ delivered: 2, dropped: 1, remaining: 0 });

    hub.setUp(false);
    await expect(store(hub, { queue: false }).insert(record())).rejects.toThrow(/Nothing was sent/);
  });

  it("says plainly when the hub does not accept the project key", async () => {
    hub = await startHub({ isRevoked: (claims) => claims.tier === "project" });
    const failure = await store(hub).insert(record()).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(FeedbackDeliveryError);
    expect((failure as Error).message).toBe("The feedback service did not accept this server's project key: This token has been revoked.");
  });

  it("refuses plain http to another machine, and a key it cannot read", () => {
    expect(() => remoteStore({ endpoint: "http://feedback.example.com", projectKey: "a.b.c" })).toThrow(/https/);
    expect(() => remoteStore({ endpoint: "https://feedback.example.com", projectKey: "not-a-key" })).toThrow(/project key/);
    expect(() => remoteStore({ endpoint: "https://feedback.example.com" })).toThrow(/projectKey/);
  });

  it("reads MCP_FEEDBACK_DISABLED", () => {
    expect(feedbackDisabled({ MCP_FEEDBACK_DISABLED: "1" })).toBe(true);
    expect(feedbackDisabled({ MCP_FEEDBACK_DISABLED: "TRUE" })).toBe(true);
    expect(feedbackDisabled({})).toBe(false);
  });
});

describe("one hub for many servers", () => {
  it("collects from several servers on several machines, and one reader sees them all or one at a time", async () => {
    hub = await startHub();
    const servers = ["utm", "notarize"];
    for (const name of servers) {
      // Two machines per server: separate state directories, so separate installations.
      for (let machine = 0; machine < 2; machine++) {
        const sink = remoteStore({ endpoint: hub.url, projectKey: hub.projectKeyFor(name), stateDir: stateDir() });
        const agent = await connect((server) => registerFeedback(server, { store: sink }));
        expect((await call(agent, "submit_feedback", { kind: "bug", title: `${name} on machine ${machine}`, body: "b" })).isError).toBe(false);
      }
    }
    const maintainer = await connect((server) => registerFeedbackReader(server, { store: hub!.store }));
    const all = await call(maintainer, "feedback_stats", {});
    expect(all.data).toMatchObject({ total: 4, by_server: { utm: 2, notarize: 2 } });
    const one = await call(maintainer, "list_feedback", { server: "utm" });
    expect(one.data!.items.map((item: FeedbackRecord) => item.server.name)).toEqual(["utm", "utm"]);
    expect(new Set(one.data!.items.map((item: FeedbackRecord) => item.identity.subject)).size).toBe(2);
  });
});

describe("a stdio server filing feedback through a hub", () => {
  it("reaches the maintainer's reader, and says so when it had to queue", async () => {
    hub = await startHub();
    const sink = store(hub);
    const agent = await connect((server) =>
      registerFeedback(server, { store: sink, requireConfirmation: true, destination: "the Acme maintainers (hub.test)" }),
    );
    const { tools } = await agent.listTools();
    expect(tools[0]!.description).toContain("Reports leave this machine and are sent to the Acme maintainers (hub.test).");

    const filed = await call(agent, "submit_feedback", { kind: "friction", title: "Confusing", body: "The flag names are unclear." });
    expect(filed.isError).toBe(false);
    expect(filed.data).toMatchObject({ status: "new" });
    expect(filed.data).not.toHaveProperty("delivery");

    const maintainer = await connect((server) => registerFeedbackReader(server, { store: hub!.store }));
    const listed = await call(maintainer, "list_feedback", {});
    expect(listed.data!.items).toHaveLength(1);
    expect(listed.data!.items[0]).toMatchObject({ id: filed.data!.id, identity: { scopes: ["ingest:install"] }, server: { name: "acme" } });

    hub.setUp(false);
    const queued = await call(agent, "submit_feedback", { kind: "bug", title: "Broke", body: "It broke." });
    expect(queued.isError).toBe(false);
    expect(queued.data).toMatchObject({ delivery: "queued", note: expect.stringContaining("Deleting that file cancels it") });

  });
});
