#!/usr/bin/env node
// One-line release of the mcp-feedback package:
//
//   pnpm release [patch|minor|major|<x.y.z>] --otp=<code> [--dry-run]
//
// From a clean, up-to-date main: optionally bumps the version, publishes to npm
// (prepublishOnly runs typecheck, tests and build first), then commits the bump,
// tags v<version> and pushes. Nothing is committed, tagged or pushed unless npm
// accepted the package. Run it in a terminal you type into (or with --otp), since
// npm asks for two-factor authentication.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkgDir = `${root}packages/typescript`;
const pkgJson = `${pkgDir}/package.json`;

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const dryRun = args.includes("--dry-run");
const otp = args.find((arg) => arg.startsWith("--otp="));
const bump = args.find((arg) => !arg.startsWith("--"));

const run = (cmd, cmdArgs, options = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...options });
const read = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const version = () => JSON.parse(readFileSync(pkgJson, "utf8")).version;

if (bump && !/^(patch|minor|major|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(bump)) fail(`unknown version "${bump}"; use patch, minor, major or x.y.z`);
if (read("git", ["status", "--porcelain"])) fail("the working tree has uncommitted changes; commit or stash them first");
if (read("git", ["branch", "--show-current"]) !== "main") fail("releases are cut from main; merge your branch first");
run("git", ["fetch", "--quiet", "origin", "main"]);
if (read("git", ["rev-parse", "HEAD"]) !== read("git", ["rev-parse", "origin/main"])) fail("main differs from origin/main; pull or push first");

if (bump) run("npm", ["version", bump, "--no-git-tag-version"], { cwd: pkgDir, stdio: ["inherit", "ignore", "inherit"] });
const next = version();
const tag = `v${next}`;
const undoBump = () => bump && run("git", ["checkout", "--", pkgJson]);

try {
  const published = read("npm", ["view", `mcp-feedback@${next}`, "version"]);
  if (published) {
    undoBump();
    fail(`mcp-feedback@${next} is already on npm; pass a version bump`);
  }
} catch {
  // npm view exits non-zero for a version that does not exist yet.
}
if (read("git", ["tag", "--list", tag])) {
  undoBump();
  fail(`tag ${tag} already exists`);
}

console.log(`release: publishing mcp-feedback@${next}${dryRun ? " (dry run)" : ""}`);
try {
  run("npm", ["publish", pkgDir, "--access", "public", ...(otp ? [otp] : []), ...(dryRun ? ["--dry-run"] : [])]);
} catch {
  undoBump();
  fail("npm publish failed; nothing was committed, tagged or pushed");
}

if (dryRun) {
  undoBump();
  console.log(`release: dry run done; would commit, tag ${tag} and push`);
  process.exit(0);
}

if (bump) run("git", ["commit", "--quiet", "-m", `Release mcp-feedback ${next}`, "--", pkgJson]);
run("git", ["tag", "-a", tag, "-m", `mcp-feedback ${next}`]);
run("git", ["push", "--quiet", "origin", "main", tag]);
console.log(`release: mcp-feedback@${next} published, tagged ${tag} and pushed`);
