import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createIngestHandler,
  generateKeyPair,
  issueToken,
  toNodeListener,
  type IngestOptions,
} from "../src/ingest/index.js";
import { memoryStore } from "../src/index.js";

export const ISSUER = "https://hub.test";

/**
 * A hub over real HTTP on a free port, with its keys and one shared store. It accepts any project
 * its key signed; `project` is the one the shortcuts below issue tokens for.
 */
export async function startHub(overrides: Partial<IngestOptions> = {}, project = "acme") {
  const key = generateKeyPair("k1");
  const signer = { kid: key.kid, privateKey: key.privateKey };
  const store = memoryStore();
  const options: IngestOptions = {
    issuer: ISSUER,
    keyring: { keys: [{ kid: key.kid, publicKey: key.publicKey }], signer },
    store,
    ...overrides,
  };
  const listener = toNodeListener(createIngestHandler(options));
  let up = true;
  const http: Server = createServer((req, res) => {
    // Lets a test take the hub "down" without closing the port.
    if (!up) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unavailable", message: "down" } }));
      return;
    }
    void listener(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    store,
    signer,
    projectKey: issueToken({ issuer: ISSUER, project, tier: "project" }, signer).token,
    projectKeyFor: (name: string) => issueToken({ issuer: ISSUER, project: name, tier: "project" }, signer).token,
    issue: (subject: string, ttlSeconds = 3600, name = project) =>
      issueToken({ issuer: ISSUER, project: name, tier: "issued", subject, ttlSeconds }, signer).token,
    setUp: (value: boolean) => {
      up = value;
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

export async function post(url: string, token: string | null, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: (await response.json().catch(() => null)) as any };
}

export const submission = (overrides: Record<string, unknown> = {}) => ({
  kind: "bug",
  title: "The thing broke",
  body: "Calling do_thing returned an error.",
  ...overrides,
});
