// Signed tokens for the ingest hub (spec/ingest.md). Compact JWTs signed with Ed25519, with the
// algorithm fixed: a token whose header names any other algorithm is rejected, never "verified"
// some other way.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

/**
 * What a token was issued for.
 * - `project`: names a project. Ships inside a distributed package, so it is public; it can only enrol.
 * - `install`: issued by the hub to one installation when it enrols. Anonymous but stable.
 * - `issued`: issued by a maintainer to a person or team they know.
 */
export const TOKEN_TIERS = ["project", "install", "issued"] as const;
export type TokenTier = (typeof TOKEN_TIERS)[number];

export interface TokenClaims {
  /** The hub that will accept the token. */
  iss: string;
  /** The project the token belongs to. */
  prj: string;
  tier: TokenTier;
  /** Who it was issued to: `project:<name>`, `install:<random>`, or the subject a maintainer chose. */
  sub: string;
  /** Issued at, seconds since the epoch. */
  iat: number;
  /** Expires at, seconds since the epoch. Optional for project keys only. */
  exp?: number;
  /** Unique id, for revoking one token. */
  jti: string;
}

export interface SigningKey {
  kid: string;
  /** PEM (PKCS#8) or a KeyObject. */
  privateKey: string | KeyObject;
}

export interface VerificationKey {
  kid: string;
  /** PEM (SPKI) or a KeyObject. */
  publicKey: string | KeyObject;
}

/**
 * The keys a hub trusts, and optionally the one it signs install tokens with. Listing several
 * `kid`s lets a key be rotated without invalidating tokens signed by the old one.
 */
export interface Keyring {
  keys: VerificationKey[];
  signer?: SigningKey;
}

/** A token failed verification. The message is safe to return to the caller. */
export class TokenError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed" | "signature" | "expired" | "issuer" | "tier" | "unknown_key",
  ) {
    super(message);
  }
}

const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Tokens are short; anything longer is not one of ours and is not worth parsing. */
const MAX_TOKEN_LENGTH = 4096;
/** Accepted clock difference between whoever signed a token and the hub. */
const CLOCK_SKEW_SECONDS = 300;

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url");

export function isValidProjectName(name: string): boolean {
  return PROJECT_PATTERN.test(name);
}

/** A new Ed25519 key pair, as PEM. Keep the private key out of anything you distribute. */
export function generateKeyPair(kid = `k${Date.now().toString(36)}`): { kid: string; privateKey: string; publicKey: string } {
  if (!KID_PATTERN.test(kid)) throw new Error("kid must be 1 to 64 letters, digits, _ or -.");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    kid,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** The public half of a private key, for a keyring entry. */
export function publicKeyOf(privateKey: string | KeyObject): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

function asPrivate(key: string | KeyObject): KeyObject {
  const object = typeof key === "string" ? createPrivateKey(key) : key;
  if (object.asymmetricKeyType !== "ed25519") throw new Error("Signing keys must be Ed25519.");
  return object;
}

function asPublic(key: string | KeyObject): KeyObject {
  const object = typeof key === "string" ? createPublicKey(key) : key;
  if (object.asymmetricKeyType !== "ed25519") throw new Error("Verification keys must be Ed25519.");
  return object;
}

export function newTokenId(): string {
  return randomBytes(12).toString("base64url");
}

/** Signs a token. Callers decide the claims; `issueToken` is the usual way in. */
export function signToken(claims: TokenClaims, signer: SigningKey): string {
  if (!KID_PATTERN.test(signer.kid)) throw new Error("kid must be 1 to 64 letters, digits, _ or -.");
  if (!isValidProjectName(claims.prj)) throw new Error("Project names are lowercase letters, digits, ., _ or -, at most 64.");
  if (claims.tier !== "project" && claims.exp === undefined) throw new Error(`An ${claims.tier} token needs an expiry.`);
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: signer.kid }));
  const payload = b64(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), asPrivate(signer.privateKey));
  return `${header}.${payload}.${b64(signature)}`;
}

/** Builds and signs a token for a tier with sensible defaults for the rest. */
export function issueToken(
  options: { issuer: string; project: string; tier: TokenTier; subject?: string; ttlSeconds?: number; now?: Date },
  signer: SigningKey,
): { token: string; claims: TokenClaims } {
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const subject =
    options.subject ?? (options.tier === "project" ? `project:${options.project}` : options.tier === "install" ? `install:${newTokenId()}` : undefined);
  if (!subject) throw new Error("An issued token needs a subject: who it is for.");
  const claims: TokenClaims = {
    iss: options.issuer,
    prj: options.project,
    tier: options.tier,
    sub: subject,
    iat,
    ...(options.ttlSeconds !== undefined ? { exp: iat + options.ttlSeconds } : {}),
    jti: newTokenId(),
  };
  return { token: signToken(claims, signer), claims };
}

function parseJson(part: string): unknown {
  try {
    return JSON.parse(unb64(part).toString("utf8"));
  } catch {
    throw new TokenError("The token is not well formed.", "malformed");
  }
}

function isClaims(value: unknown): value is TokenClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.iss === "string" &&
    typeof claims.prj === "string" &&
    isValidProjectName(claims.prj) &&
    typeof claims.tier === "string" &&
    (TOKEN_TIERS as readonly string[]).includes(claims.tier) &&
    typeof claims.sub === "string" &&
    claims.sub.length > 0 &&
    claims.sub.length <= 200 &&
    typeof claims.iat === "number" &&
    (claims.exp === undefined || typeof claims.exp === "number") &&
    typeof claims.jti === "string" &&
    claims.jti.length > 0 &&
    claims.jti.length <= 64
  );
}

/**
 * Verifies a token's signature, issuer, expiry and tier, and returns its claims. Throws a
 * TokenError otherwise. Revocation is the caller's check, against `jti` or `sub`.
 */
export function verifyToken(
  token: string,
  keyring: Pick<Keyring, "keys">,
  options: { issuer: string; tiers: readonly TokenTier[]; now?: Date },
): TokenClaims {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new TokenError("The token is not well formed.", "malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new TokenError("The token is not well formed.", "malformed");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = parseJson(headerPart) as Record<string, unknown> | null;
  if (!header || header.alg !== "EdDSA" || typeof header.kid !== "string") {
    throw new TokenError("The token is not signed the way this hub signs tokens.", "malformed");
  }
  const key = keyring.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new TokenError("The token was signed by a key this hub does not know.", "unknown_key");
  const valid = verify(null, Buffer.from(`${headerPart}.${payloadPart}`), asPublic(key.publicKey), unb64(signaturePart));
  if (!valid) throw new TokenError("The token's signature is not valid.", "signature");

  // Only a token with a valid signature gets its claims looked at.
  const claims = parseJson(payloadPart);
  if (!isClaims(claims)) throw new TokenError("The token's claims are not well formed.", "malformed");
  if (claims.iss !== options.issuer) throw new TokenError("The token was issued for a different hub.", "issuer");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp !== undefined && claims.exp + CLOCK_SKEW_SECONDS < now) throw new TokenError("The token has expired.", "expired");
  if (claims.iat - CLOCK_SKEW_SECONDS > now) throw new TokenError("The token is not valid yet.", "expired");
  if (claims.tier !== "project" && claims.exp === undefined) throw new TokenError("The token has no expiry.", "malformed");
  if (!options.tiers.includes(claims.tier)) {
    throw new TokenError(`A ${claims.tier} token cannot be used here.`, "tier");
  }
  return claims;
}
