import { afterEach, describe, expect, it } from "vitest";
import { createIngestHandler, generateKeyPair, issueToken, publicKeyOf, toNodeListener } from "../src/ingest/index.js";
import { memoryStore, type FeedbackStore } from "../src/index.js";
import { uuidv7 } from "../src/register.js";
import { fakeGitHub, ISSUER, post, startHub, submission } from "./ingest-helpers.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
let hub: Hub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

async function enrolled(h: Hub): Promise<string> {
  const response = await post(`${h.url}/v1/enroll`, h.projectKey, {});
  expect(response.status).toBe(201);
  return response.body.token;
}

describe("ingest hub", () => {
  it("enrols an installation and stamps its reports, ignoring what the body claims", async () => {
    hub = await startHub();
    const enrol = await post(`${hub.url}/v1/enroll`, hub.projectKey, {});
    expect(enrol.body).toMatchObject({ subject: expect.stringMatching(/^install:/) });
    expect(Date.parse(enrol.body.expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    const response = await post(`${hub.url}/v1/feedback`, enrol.body.token, {
      ...submission(),
      // None of these may reach the stored record as given.
      identity: { subject: "admin" },
      status: "resolved",
      server: { name: "someone-else" },
      server_context: { version: "1.2.3", ingest: { tier: "issued" } },
      server_version: "1.2.3",
      client_name: "claude-code",
    });
    expect(response.status).toBe(201);
    const record = (await hub.store.get(response.body.id))!;
    expect(record.status).toBe("new");
    expect(record.server).toEqual({ name: "acme", version: "1.2.3" });
    expect(record.identity).toMatchObject({
      subject: enrol.body.subject,
      client_id: "acme",
      scopes: ["ingest:install"],
      client_name: "claude-code",
      token_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(record.context.server_context).toMatchObject({ version: "1.2.3", ingest: { tier: "install", received_at: record.created_at } });
  });

  it("records an issued token's subject and tier", async () => {
    hub = await startHub();
    const response = await post(`${hub.url}/v1/feedback`, hub.issue("alice@example.com"), submission());
    expect(response.status).toBe(201);
    const record = (await hub.store.get(response.body.id))!;
    expect(record.identity).toMatchObject({ subject: "alice@example.com", scopes: ["ingest:issued"] });
  });

  it("accepts each tier only where it belongs", async () => {
    hub = await startHub();
    const install = await enrolled(hub);
    expect((await post(`${hub.url}/v1/feedback`, hub.projectKey, submission())).status).toBe(401);
    expect((await post(`${hub.url}/v1/enroll`, install, {})).status).toBe(401);
    expect((await post(`${hub.url}/v1/feedback`, null, submission())).status).toBe(401);
    const garbage = await post(`${hub.url}/v1/feedback`, "not.a.token", submission());
    expect(garbage).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
  });

  it("refuses revoked tokens", async () => {
    hub = await startHub({ isRevoked: (claims) => claims.sub === "mallory" });
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("mallory"), submission())).status).toBe(403);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("alice"), submission())).status).toBe(201);
  });

  it("applies the same limits as registerFeedback, with the same messages", async () => {
    hub = await startHub();
    const token = hub.issue("alice");
    const long = await post(`${hub.url}/v1/feedback`, token, submission({ title: "x".repeat(201) }));
    expect(long).toMatchObject({ status: 400, body: { error: { message: "title is 201 characters; the limit is 200. Shorten it and resubmit." } } });
    expect((await post(`${hub.url}/v1/feedback`, token, submission({ body: "   " }))).status).toBe(400);
    expect((await post(`${hub.url}/v1/feedback`, token, submission({ kind: "rant" }))).status).toBe(400);
    expect((await post(`${hub.url}/v1/feedback`, token, "{not json")).status).toBe(400);
    const context = await post(`${hub.url}/v1/feedback`, token, submission({ server_context: { blob: "x".repeat(20000) } }));
    expect(context.status).toBe(400);
  });

  it("refuses an oversized body before parsing it", async () => {
    hub = await startHub();
    const response = await post(`${hub.url}/v1/feedback`, hub.issue("alice"), submission({ body: "x".repeat(70_000) }));
    expect(response).toMatchObject({ status: 413, body: { error: { code: "payload_too_large" } } });
  });

  it("enforces per-installation and per-project daily quotas", async () => {
    hub = await startHub({ quotas: { perIssuedSubjectPerDay: 2, perProjectPerDay: 3 } });
    const alice = hub.issue("alice");
    expect((await post(`${hub.url}/v1/feedback`, alice, submission())).status).toBe(201);
    expect((await post(`${hub.url}/v1/feedback`, alice, submission())).status).toBe(201);
    const limited = await post(`${hub.url}/v1/feedback`, alice, submission());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("bob"), submission())).status).toBe(201);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("carol"), submission())).status).toBe(429);
  });

  it("treats a repeated id from the same submitter as a retry, and refuses it from anyone else", async () => {
    hub = await startHub();
    const id = uuidv7();
    const alice = hub.issue("alice");
    const first = await post(`${hub.url}/v1/feedback`, alice, submission({ id }));
    const again = await post(`${hub.url}/v1/feedback`, alice, submission({ id }));
    expect(first).toMatchObject({ status: 201, body: { id } });
    expect(again).toMatchObject({ status: 200, body: { id, duplicate: true } });
    expect((await hub.store.stats({})).total).toBe(1);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("bob"), submission({ id }))).status).toBe(409);
  });

  it("replaces an id that is not a recent UUIDv7", async () => {
    hub = await startHub();
    const old = uuidv7(Date.now() - 40 * 24 * 3600 * 1000);
    for (const id of [old, "my-own-id"]) {
      const response = await post(`${hub.url}/v1/feedback`, hub.issue("alice"), submission({ id }));
      expect(response.status).toBe(201);
      expect(response.body.id).not.toBe(id);
    }
  });

  it("with a project list, refuses projects not on it; and refuses a configuration it cannot work with", async () => {
    hub = await startHub({ projects: { acme: {} } });
    const other = issueToken({ issuer: ISSUER, project: "other", tier: "issued", subject: "a", ttlSeconds: 60 }, hub.signer).token;
    expect((await post(`${hub.url}/v1/feedback`, other, submission())).status).toBe(404);
    expect((await post(`${hub.url}/v1/enroll`, hub.projectKeyFor("other"), {})).status).toBe(404);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("a"), submission())).status).toBe(201);
    await expect(startHub({ keyring: { keys: [] } })).rejects.toThrow(/at least one verification key/);
    await expect(startHub({ projects: { "Not Valid": {} } })).rejects.toThrow(/Invalid project name/);
    await expect(startHub({ store: undefined, projects: { acme: {} } })).rejects.toThrow(/no store/);
  });

  it("keeps many projects in one store, each under its own name, with its own quotas", async () => {
    hub = await startHub({ quotas: { perProjectPerDay: 2 } });
    for (const name of ["utm", "notarize", "memecp-cli"]) {
      const enrol = await post(`${hub.url}/v1/enroll`, hub.projectKeyFor(name), {});
      expect(enrol.status).toBe(201);
      expect((await post(`${hub.url}/v1/feedback`, enrol.body.token, submission({ title: `from ${name}` }))).status).toBe(201);
    }
    const stats = await hub.store.stats({});
    expect(stats.by_server).toEqual({ utm: 1, notarize: 1, "memecp-cli": 1 });
    const page = await hub.store.list({ server: "notarize", limit: 10 });
    expect(page.items.map((item) => [item.title, item.identity.client_id])).toEqual([["from notarize", "notarize"]]);

    // utm reaching its daily limit leaves the others alone.
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("x", 3600, "utm"), submission())).status).toBe(201);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("y", 3600, "utm"), submission())).status).toBe(429);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("x", 3600, "notarize"), submission())).status).toBe(201);
  });

  it("sends a listed project to its own store, the rest to the shared one", async () => {
    const own = memoryStore();
    hub = await startHub({ projects: { legacy: { store: own }, utm: {} } });
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("a", 3600, "legacy"), submission())).status).toBe(201);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("a", 3600, "utm"), submission())).status).toBe(201);
    expect((await own.stats({})).by_server).toEqual({ legacy: 1 });
    expect((await hub.store.stats({})).by_server).toEqual({ utm: 1 });
  });

  it("does not treat the same subject's id in another project as a retry", async () => {
    hub = await startHub();
    const id = uuidv7();
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("alice", 3600, "utm"), submission({ id }))).status).toBe(201);
    expect((await post(`${hub.url}/v1/feedback`, hub.issue("alice", 3600, "notarize"), submission({ id }))).status).toBe(409);
  });

  it("answers 501 to enrolment when it has no signing key, and still takes issued tokens", async () => {
    const key = generateKeyPair("k1");
    hub = await startHub({ keyring: { keys: [{ kid: key.kid, publicKey: publicKeyOf(key.privateKey) }] } });
    const projectKey = issueToken({ issuer: ISSUER, project: "acme", tier: "project" }, key).token;
    const issued = issueToken({ issuer: ISSUER, project: "acme", tier: "issued", subject: "a", ttlSeconds: 60 }, key).token;
    expect((await post(`${hub.url}/v1/enroll`, projectKey, {})).status).toBe(501);
    expect((await post(`${hub.url}/v1/feedback`, issued, submission())).status).toBe(201);
  });

  it("limits enrolments per address", async () => {
    hub = await startHub({ quotas: { enrollPerAddressPerHour: 1 } });
    expect((await post(`${hub.url}/v1/enroll`, hub.projectKey, {})).status).toBe(201);
    expect((await post(`${hub.url}/v1/enroll`, hub.projectKey, {})).status).toBe(429);
  });

  it("takes the client address from Express's req.ip, or a clientAddress function, for the enrolment limit", async () => {
    const { createServer } = await import("node:http");
    const key = generateKeyPair("k1");
    const signer = { kid: key.kid, privateKey: key.privateKey };
    const projectKey = issueToken({ issuer: ISSUER, project: "acme", tier: "project" }, signer).token;
    for (const options of [{}, { clientAddress: (req: { headers: Record<string, unknown> }) => String(req.headers["x-test-ip"]) }]) {
      const handler = createIngestHandler({ issuer: ISSUER, keyring: { keys: [{ kid: key.kid, publicKey: key.publicKey }], signer }, store: memoryStore(), quotas: { enrollPerAddressPerHour: 1 } });
      const listener = toNodeListener(handler, options as Parameters<typeof toNodeListener>[1]);
      const server = createServer((req, res) => {
        // What Express does with `trust proxy`: req.ip is the address the app trusts.
        Object.defineProperty(req, "ip", { value: String(req.headers["x-test-ip"]) });
        void listener(req, res);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/enroll`;
      const enrol = (ip: string) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${projectKey}`, "x-test-ip": ip } }).then((r) => r.status);
      expect([await enrol("203.0.113.1"), await enrol("203.0.113.1"), await enrol("203.0.113.2")]).toEqual([201, 429, 201]);
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  it("answers 404 and 405 for other paths and methods", async () => {
    hub = await startHub();
    expect((await post(`${hub.url}/v1/other`, null, {})).status).toBe(404);
    expect((await fetch(`${hub.url}/v1/feedback`)).status).toBe(405);
  });

  it("renews install tokens with the same subject, and refuses what it should not renew", async () => {
    hub = await startHub({ isRevoked: (claims) => claims.sub === "install:revoked" });
    const enrol = await post(`${hub.url}/v1/enroll`, hub.projectKey, {});
    const renewed = await post(`${hub.url}/v1/renew`, enrol.body.token, {});
    expect(renewed).toMatchObject({ status: 200, body: { subject: enrol.body.subject, tier: "install" } });
    expect(renewed.body.token).not.toBe(enrol.body.token);
    expect((await post(`${hub.url}/v1/feedback`, renewed.body.token, submission())).status).toBe(201);

    expect((await post(`${hub.url}/v1/renew`, hub.projectKey, {})).status).toBe(401);
    expect((await post(`${hub.url}/v1/renew`, hub.issue("alice"), {})).status).toBe(401);
    const revoked = issueToken({ issuer: ISSUER, project: "acme", tier: "install", subject: "install:revoked", ttlSeconds: 60 }, hub.signer).token;
    expect((await post(`${hub.url}/v1/renew`, revoked, {})).status).toBe(403);
    const old = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60, now: new Date(Date.now() - 3_600_000) }, hub.signer).token;
    expect((await post(`${hub.url}/v1/renew`, old, {})).status).toBe(401);
  });

  it("publishes what it offers at .well-known", async () => {
    hub = await startHub();
    const plain = await (await fetch(`${hub.url}/.well-known/mcp-feedback`)).json();
    expect(plain).toEqual({
      issuer: ISSUER,
      endpoints: { enroll: "/v1/enroll", feedback: "/v1/feedback", renew: "/v1/renew" },
      signin: {},
      install_token_ttl_seconds: 30 * 86400,
      user_token_ttl_seconds: null,
    });
    await hub.close();
    hub = await startHub({ github: { clientId: "Iv1.test", fetch: fakeGitHub().fetch } });
    const withGitHub = await (await fetch(`${hub.url}/.well-known/mcp-feedback`)).json();
    expect(withGitHub.signin).toEqual({ github: { start: "/v1/signin/github/start", poll: "/v1/signin/github/poll" } });
    expect(withGitHub.user_token_ttl_seconds).toBe(180 * 86400);
  });

  it("signs a person in with GitHub and makes them the submitter for any project", async () => {
    const github = fakeGitHub({ login: "octocat" });
    hub = await startHub({ github: { clientId: "Iv1.test", fetch: github.fetch } });
    const start = await post(`${hub.url}/v1/signin/github/start`, hub.projectKey, {});
    expect(start).toMatchObject({ status: 200, body: { user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", handle: "device-1" } });
    expect((await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" })).status).toBe(202);
    github.approve();
    const done = await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" });
    expect(done).toMatchObject({ status: 200, body: { subject: "github:octocat", tier: "user" } });
    const userToken = done.body.token;

    // The sign-in is for the hub, not one project: it works with any project's key.
    for (const name of ["utm", "notarize"]) {
      const enrol = await post(`${hub.url}/v1/enroll`, hub.projectKeyFor(name), { user_token: userToken });
      expect(enrol.body).toMatchObject({ subject: "github:octocat", tier: "issued" });
      expect((await post(`${hub.url}/v1/feedback`, enrol.body.token, submission())).status).toBe(201);
    }
    expect((await hub.store.list({ limit: 10 })).items.map((item) => [item.server.name, item.identity.subject, item.identity.scopes[0]])).toEqual(
      expect.arrayContaining([
        ["utm", "github:octocat", "ingest:issued"],
        ["notarize", "github:octocat", "ingest:issued"],
      ]),
    );
    // A user token is only for enrolling and renewing.
    expect((await post(`${hub.url}/v1/feedback`, userToken, submission())).status).toBe(401);
    expect((await post(`${hub.url}/v1/renew`, userToken, {})).body).toMatchObject({ subject: "github:octocat", tier: "user" });
    expect((await post(`${hub.url}/v1/enroll`, hub.projectKey, { user_token: "not.a.token" })).status).toBe(401);
  });

  it("refuses GitHub users outside the allow list, declined and expired sign-ins, and revoked accounts", async () => {
    const github = fakeGitHub({ login: "stranger", orgs: ["elsewhere"] });
    hub = await startHub({ github: { clientId: "Iv1.test", allowedOrgs: ["krishchow-org"], fetch: github.fetch } });
    await post(`${hub.url}/v1/signin/github/start`, hub.projectKey, {});
    github.approve();
    const outsider = await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" });
    expect(outsider).toMatchObject({ status: 403, body: { error: { code: "not_allowed" } } });
    expect(github.calls).toContain("/user/orgs");

    github.deny();
    expect((await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" })).status).toBe(403);
    github.expire();
    expect((await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" })).status).toBe(410);
    await hub.close();

    const approved = fakeGitHub({ login: "mallory" });
    hub = await startHub({ github: { clientId: "Iv1.test", fetch: approved.fetch }, isRevoked: (claims) => claims.sub === "github:mallory" });
    approved.approve();
    expect((await post(`${hub.url}/v1/signin/github/poll`, hub.projectKey, { handle: "device-1" })).status).toBe(403);
    await hub.close();

    hub = await startHub();
    expect((await post(`${hub.url}/v1/signin/github/start`, hub.projectKey, {})).status).toBe(501);
  });

  it("hides store failures behind a generic message and reports them to onError", async () => {
    const errors: unknown[] = [];
    const broken: FeedbackStore = { ...memoryStore(), insert: async () => Promise.reject(new Error("disk on fire")) };
    const key = generateKeyPair("k1");
    const handler = createIngestHandler({
      issuer: ISSUER,
      keyring: { keys: [{ kid: key.kid, publicKey: key.publicKey }] },
      store: broken,
      onError: (error) => errors.push(error),
    });
    const token = issueToken({ issuer: ISSUER, project: "acme", tier: "issued", subject: "a", ttlSeconds: 60 }, key).token;
    const response = await handler(
      new Request("http://hub.test/v1/feedback", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(submission()) }),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/disk on fire/);
    expect(String(errors[0])).toMatch(/disk on fire/);
  });
});
