import { describe, expect, it } from "vitest";
import { generateKeyPair, issueToken, publicKeyOf, signToken, TokenError, verifyToken } from "../src/ingest/index.js";

const ISSUER = "https://hub.test";
const key = generateKeyPair("k1");
const signer = { kid: key.kid, privateKey: key.privateKey };
const keyring = { keys: [{ kid: key.kid, publicKey: key.publicKey }] };
const all = ["project", "install", "issued"] as const;

function reason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof TokenError) return error.reason;
    throw error;
  }
  return undefined;
}

describe("ingest tokens", () => {
  it("verifies a token it signed and returns its claims", () => {
    const { token } = issueToken({ issuer: ISSUER, project: "acme", tier: "issued", subject: "alice", ttlSeconds: 60 }, signer);
    const claims = verifyToken(token, keyring, { issuer: ISSUER, tiers: all });
    expect(claims).toMatchObject({ iss: ISSUER, prj: "acme", tier: "issued", sub: "alice" });
    expect(publicKeyOf(key.privateKey)).toBe(key.publicKey);
  });

  it("gives install and project tokens their own subjects", () => {
    const install = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60 }, signer).claims;
    const project = issueToken({ issuer: ISSUER, project: "acme", tier: "project" }, signer).claims;
    expect(install.sub).toMatch(/^install:/);
    expect(project.sub).toBe("project:acme");
    expect(project.exp).toBeUndefined();
  });

  it("rejects a tampered payload", () => {
    const { token } = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60 }, signer);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, tier: "issued", sub: "admin" })).toString("base64url");
    expect(reason(() => verifyToken(`${header}.${forged}.${signature}`, keyring, { issuer: ISSUER, tiers: all }))).toBe("signature");
  });

  it("rejects any algorithm other than EdDSA, including none", () => {
    const { token } = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60 }, signer);
    const [, payload, signature] = token.split(".");
    for (const alg of ["none", "HS256", "RS256"]) {
      const header = Buffer.from(JSON.stringify({ alg, typ: "JWT", kid: "k1" })).toString("base64url");
      expect(reason(() => verifyToken(`${header}.${payload}.${signature}`, keyring, { issuer: ISSUER, tiers: all }))).toBe("malformed");
    }
    expect(reason(() => verifyToken(`${token.split(".")[0]}.${payload}.`, keyring, { issuer: ISSUER, tiers: all }))).toBe("malformed");
  });

  it("rejects a token from an unknown key, and one signed by another key under a known kid", () => {
    const other = generateKeyPair("k2");
    const { token } = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60 }, other);
    expect(reason(() => verifyToken(token, keyring, { issuer: ISSUER, tiers: all }))).toBe("unknown_key");
    const impostor = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60 }, { kid: "k1", privateKey: other.privateKey });
    expect(reason(() => verifyToken(impostor.token, keyring, { issuer: ISSUER, tiers: all }))).toBe("signature");
  });

  it("rejects an expired token, a future one, and one for another hub", () => {
    const old = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60, now: new Date(Date.now() - 3_600_000) }, signer);
    expect(reason(() => verifyToken(old.token, keyring, { issuer: ISSUER, tiers: all }))).toBe("expired");
    const future = issueToken({ issuer: ISSUER, project: "acme", tier: "install", ttlSeconds: 60, now: new Date(Date.now() + 3_600_000) }, signer);
    expect(reason(() => verifyToken(future.token, keyring, { issuer: ISSUER, tiers: all }))).toBe("expired");
    const elsewhere = issueToken({ issuer: "https://other.test", project: "acme", tier: "install", ttlSeconds: 60 }, signer);
    expect(reason(() => verifyToken(elsewhere.token, keyring, { issuer: ISSUER, tiers: all }))).toBe("issuer");
  });

  it("accepts a tier only where it is allowed", () => {
    const project = issueToken({ issuer: ISSUER, project: "acme", tier: "project" }, signer).token;
    expect(reason(() => verifyToken(project, keyring, { issuer: ISSUER, tiers: ["install", "issued"] }))).toBe("tier");
    expect(verifyToken(project, keyring, { issuer: ISSUER, tiers: ["project"] }).tier).toBe("project");
  });

  it("keeps * for user tokens only", () => {
    const user = issueToken({ issuer: ISSUER, project: "*", tier: "user", subject: "github:octocat", ttlSeconds: 60 }, signer);
    expect(verifyToken(user.token, keyring, { issuer: ISSUER, tiers: ["user"] }).prj).toBe("*");
    expect(() => issueToken({ issuer: ISSUER, project: "*", tier: "install", ttlSeconds: 60 }, signer)).toThrow(/only for a user token/);
    expect(() => issueToken({ issuer: ISSUER, project: "acme", tier: "user", subject: "github:x", ttlSeconds: 60 }, signer)).toThrow(/only for a user token/);
    expect(() => issueToken({ issuer: ISSUER, project: "*", tier: "user", ttlSeconds: 60 }, signer)).toThrow(/subject/);
  });

  it("refuses to sign what it would not accept", () => {
    expect(() => signToken({ iss: ISSUER, prj: "acme", tier: "install", sub: "install:x", iat: 0, jti: "j" }, signer)).toThrow(/expiry/);
    expect(() => issueToken({ issuer: ISSUER, project: "Bad Name", tier: "project" }, signer)).toThrow(/Project names/);
    expect(() => issueToken({ issuer: ISSUER, project: "acme", tier: "issued" }, signer)).toThrow(/subject/);
    expect(reason(() => verifyToken("x".repeat(5000), keyring, { issuer: ISSUER, tiers: all }))).toBe("malformed");
    expect(reason(() => verifyToken("a.b", keyring, { issuer: ISSUER, tiers: all }))).toBe("malformed");
  });
});

describe("mcp-feedback ingest", () => {
  it("makes a key, issues tokens that verify, and never overwrites the key", async () => {
    const { mkdtempSync, readFileSync, rmSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { runCli } = await import("../src/cli.js");
    const dir = mkdtempSync(join(tmpdir(), "mcp-feedback-ingest-"));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line), env: { MCP_FEEDBACK_INGEST_ISSUER: ISSUER } };
      const keyFile = join(dir, "key.json");
      expect(await runCli(["ingest", "keygen", "--out", keyFile, "--kid", "main"], io)).toBe(0);
      expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      const key = JSON.parse(readFileSync(keyFile, "utf8"));
      expect(out.pop()).toBe(key.publicKey.trimEnd());
      expect(err.join("\n")).not.toContain("PRIVATE KEY");
      expect(await runCli(["ingest", "keygen", "--out", keyFile], io)).toBe(2);

      const ring = { keys: [{ kid: "main", publicKey: key.publicKey }] };
      expect(await runCli(["ingest", "issue-key", "--project", "acme", "--key", keyFile], io)).toBe(0);
      expect(verifyToken(out.pop()!, ring, { issuer: ISSUER, tiers: ["project"] }).sub).toBe("project:acme");
      expect(await runCli(["ingest", "issue-token", "--project", "acme", "--subject", "alice", "--days", "7"], { ...io, env: { ...io.env, MCP_FEEDBACK_INGEST_KEY: readFileSync(keyFile, "utf8") } })).toBe(0);
      const claims = verifyToken(out.pop()!, ring, { issuer: ISSUER, tiers: ["issued"] });
      expect(claims.sub).toBe("alice");
      expect(claims.exp! - claims.iat).toBe(7 * 86400);
      expect(await runCli(["ingest", "issue-key", "--project", "Bad Name", "--key", keyFile], io)).toBe(2);
      expect(await runCli(["ingest", "issue-key", "--project", "acme"], io)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
