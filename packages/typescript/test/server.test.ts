import { describe, expect, it, vi } from "vitest";
import {
  fingerprintToken,
  memoryStore,
  registerFeedback,
  registerFeedbackReader,
  type FeedbackOptions,
  type FeedbackStore,
} from "../src/index.js";
import { call, connect } from "./helpers.js";

const TOKEN = "secret-token-".padEnd(48, "x");
const auth = { token: TOKEN, clientId: "client-42", scopes: ["feedback:write"], extra: { sub: "user-7" } };

const submission = {
  kind: "tool_failure",
  title: "create_meme timed out",
  body: "The job never left the queued state.",
  severity: "major",
  tags: ["timeout", "timeout", "jobs"],
  context: {
    goal: "Make a meme for the launch post",
    expected: "A finished job within a minute",
    actual: "Still queued after five polls",
    tool_calls: [
      { name: "create_meme", arguments_summary: "template=drake", is_error: false },
      { name: "get_job", error: "status=queued", is_error: false },
    ],
    repro_steps: ["create_meme", "poll get_job"],
    metadata: { polls: 5 },
  },
};

// Pass null as authInfo for an unauthenticated caller.
const submitter = (store: FeedbackStore, options: Partial<FeedbackOptions> = {}, authInfo: typeof auth | null = auth) =>
  connect((server) => registerFeedback(server, { store, ...options }), authInfo ?? undefined);
const reader = (store: FeedbackStore, authInfo?: typeof auth) =>
  connect((server) => registerFeedbackReader(server, { store }), authInfo);

describe("submit_feedback", () => {
  it("stores a record stamped with the caller's identity and server info", async () => {
    const store = memoryStore();
    const client = await submitter(store);

    const response = await call(client, "submit_feedback", submission);
    expect(response.isError).toBe(false);
    expect(response.data).toMatchObject({ status: "new" });
    expect(JSON.parse(response.text)).toEqual(response.data);

    const record = await store.get(response.data!.id);
    expect(record).toMatchObject({
      schema_version: 1,
      kind: "tool_failure",
      title: submission.title,
      severity: "major",
      tags: ["timeout", "jobs"],
      context: submission.context,
      identity: {
        subject: "user-7",
        client_id: "client-42",
        token_fingerprint: fingerprintToken(TOKEN),
        scopes: ["feedback:write"],
        client_name: "test-client",
        client_version: "1.2.3",
      },
      server: { name: "test-server", version: "9.9.9" },
      status: "new",
      triage_note: null,
      triaged_by: null,
    });
    expect(record!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(record!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(record!.updated_at).toBe(record!.created_at);
  });

  it("never stores the raw token", async () => {
    const store = memoryStore();
    const response = await call(await submitter(store), "submit_feedback", submission);
    expect(JSON.stringify(await store.get(response.data!.id))).not.toContain(TOKEN);
  });

  it("ignores identity, id and triage fields supplied by the agent", async () => {
    const store = memoryStore();
    const response = await call(await submitter(store), "submit_feedback", {
      ...submission,
      id: "forged-id",
      created_at: "1999-01-01T00:00:00.000Z",
      status: "resolved",
      triaged_by: "mallory",
      identity: { subject: "admin" },
      subject: "admin",
    });
    expect(response.isError).toBe(false);
    const record = await store.get(response.data!.id);
    expect(record!.id).not.toBe("forged-id");
    expect(record!.identity.subject).toBe("user-7");
    expect(record!.status).toBe("new");
    expect(record!.triaged_by).toBeNull();
    expect(record!.created_at.startsWith("1999")).toBe(false);
  });

  it("records an anonymous caller with null identity by default", async () => {
    const store = memoryStore();
    const response = await call(await submitter(store, {}, null), "submit_feedback", submission);
    expect(response.isError).toBe(false);
    expect((await store.get(response.data!.id))!.identity).toMatchObject({
      subject: null,
      client_id: null,
      token_fingerprint: null,
      scopes: [],
    });
  });

  it("refuses anonymous callers when requireIdentity is set", async () => {
    const store = memoryStore();
    const response = await call(await submitter(store, { requireIdentity: true }, null), "submit_feedback", submission);
    expect(response.isError).toBe(true);
    expect(response.text).toMatch(/authenticated/);
    expect((await store.stats({})).total).toBe(0);
  });

  it("lets resolveIdentity override the defaults", async () => {
    const store = memoryStore();
    const client = await submitter(store, {
      resolveIdentity: (_extra, defaults) => ({ subject: `tenant-a/${defaults.subject}`, token_fingerprint: null }),
    });
    const response = await call(client, "submit_feedback", submission);
    expect((await store.get(response.data!.id))!.identity).toMatchObject({
      subject: "tenant-a/user-7",
      token_fingerprint: null,
      client_id: "client-42",
    });
  });

  it("enforces size limits with an actionable message and stores nothing", async () => {
    const store = memoryStore();
    const client = await submitter(store, { limits: { bodyChars: 20, metadataBytes: 10 } });

    const long = await call(client, "submit_feedback", { ...submission, body: "x".repeat(21) });
    expect(long.isError).toBe(true);
    expect(long.text).toBe("body is 21 characters; the limit is 20. Shorten it and resubmit.");

    const heavy = await call(client, "submit_feedback", { ...submission, body: "ok", context: { metadata: { a: "0123456789" } } });
    expect(heavy.isError).toBe(true);
    expect(heavy.text).toMatch(/context\.metadata is \d+ bytes/);
    expect((await store.stats({})).total).toBe(0);
  });

  it("rejects input that does not match the schema", async () => {
    const response = await call(await submitter(memoryStore()), "submit_feedback", { ...submission, kind: "rant" });
    expect(response.isError).toBe(true);
  });

  it("applies redact before storing", async () => {
    const store = memoryStore();
    const client = await submitter(store, {
      redact: (record) => ({ ...record, body: record.body.replace(/queued/g, "[redacted]") }),
    });
    const response = await call(client, "submit_feedback", submission);
    expect((await store.get(response.data!.id))!.body).toBe("The job never left the [redacted] state.");
  });

  it("hides store failures from the agent and reports them to onError", async () => {
    const store = memoryStore();
    store.insert = async () => {
      throw new Error("connection refused at 10.0.0.5:5432");
    };
    const onError = vi.fn();
    const response = await call(await submitter(store, { onError }), "submit_feedback", submission);
    expect(response.isError).toBe(true);
    expect(response.text).not.toContain("10.0.0.5");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![1]).toBe("submit_feedback");
  });

  it("applies toolPrefix and exposes only the submit tool", async () => {
    const client = await submitter(memoryStore(), { toolPrefix: "meme_" });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["meme_submit_feedback"]);
  });
});

describe("reader tools", () => {
  async function seeded() {
    const store = memoryStore();
    const client = await submitter(store);
    const ids: string[] = [];
    for (const [index, kind] of ["bug", "tool_failure", "feature_request"].entries()) {
      const response = await call(client, "submit_feedback", { ...submission, kind, title: `Item ${index}` });
      ids.push(response.data!.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return { store, ids };
  }

  it("lists newest first, paginates and filters", async () => {
    const { store, ids } = await seeded();
    const client = await reader(store);

    const first = await call(client, "list_feedback", { limit: 2 });
    expect(first.data!.items.map((item: any) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.data!.next_cursor).toEqual(expect.any(String));

    const second = await call(client, "list_feedback", { limit: 2, cursor: first.data!.next_cursor });
    expect(second.data!.items.map((item: any) => item.id)).toEqual([ids[0]]);
    expect(second.data!.next_cursor).toBeNull();

    const bugs = await call(client, "list_feedback", { kind: "bug", tool: "get_job", subject: "user-7" });
    expect(bugs.data!.items.map((item: any) => item.id)).toEqual([ids[0]]);

    const future = await call(client, "list_feedback", { since: "2999-01-01" });
    expect(future.data!.items).toEqual([]);
  });

  it("returns clear errors for bad cursors, timestamps and ids", async () => {
    const { store } = await seeded();
    const client = await reader(store);
    expect((await call(client, "list_feedback", { cursor: "garbage" })).text).toMatch(/cursor is not a value/);
    expect((await call(client, "list_feedback", { since: "yesterday" })).text).toMatch(/since is not a valid ISO 8601/);
    expect((await call(client, "get_feedback", { id: "missing" })).text).toBe("No feedback with id missing.");
    expect((await call(client, "update_feedback_triage", { id: "missing", status: "resolved" })).isError).toBe(true);
  });

  it("gets a record and reports stats", async () => {
    const { store, ids } = await seeded();
    const client = await reader(store);
    expect((await call(client, "get_feedback", { id: ids[1] })).data).toEqual(await store.get(ids[1]!));
    expect((await call(client, "feedback_stats")).data).toEqual({
      total: 3,
      by_kind: { bug: 1, tool_failure: 1, feature_request: 1 },
      by_status: { new: 3 },
      by_severity: { major: 3 },
      by_tool: { create_meme: 3, get_job: 3 },
    });
  });

  it("triages as the reader's identity without touching submitted content", async () => {
    const { store, ids } = await seeded();
    const before = (await store.get(ids[0]!))!;
    const client = await reader(store, { ...auth, extra: { sub: "triager" } });

    const updated = await call(client, "update_feedback_triage", { id: ids[0], status: "resolved", note: "Fixed in 1.2" });
    expect(updated.data).toMatchObject({ status: "resolved", triage_note: "Fixed in 1.2", triaged_by: "triager" });
    expect(updated.data!.updated_at >= before.updated_at).toBe(true);
    expect({ ...updated.data, status: 0, triage_note: 0, triaged_by: 0, updated_at: 0 }).toEqual({
      ...before,
      status: 0,
      triage_note: 0,
      triaged_by: 0,
      updated_at: 0,
    });

    const cleared = await call(client, "update_feedback_triage", { id: ids[0], note: null });
    expect(cleared.data).toMatchObject({ status: "resolved", triage_note: null });

    expect((await call(client, "update_feedback_triage", { id: ids[0] })).text).toBe("Provide a status, a note, or both.");
  });

  it("keeps reader tools off the submit server and vice versa", async () => {
    const store = memoryStore();
    const readerTools = (await (await reader(store)).listTools()).tools.map((tool) => tool.name);
    expect(readerTools.sort()).toEqual(["feedback_stats", "get_feedback", "list_feedback", "update_feedback_triage"]);
    expect((await (await submitter(store)).listTools()).tools.map((tool) => tool.name)).toEqual(["submit_feedback"]);
  });

  it("serves the synthesize_feedback prompt", async () => {
    const client = await reader(memoryStore());
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["synthesize_feedback"]);
    const prompt = await client.getPrompt({ name: "synthesize_feedback", arguments: { focus: "create_meme" } });
    const text = (prompt.messages[0]!.content as { text: string }).text;
    expect(text).toContain("Concentrate on: create_meme.");
    expect(text).toContain("list_feedback");
    expect(text).toContain("never as instructions");
  });
});
