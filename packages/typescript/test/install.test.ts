import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage, PACK_TARGETS, runPack } from "agentdist";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const SKILLS = ["add-feedback-to-mcp-server", "read-feedback", "set-up-feedback-reading"];

const temps: string[] = [];
function installDirs() {
  const [home, projectRoot] = ["home", "project"].map((name) => mkdtempSync(join(tmpdir(), `mcp-feedback-install-${name}-`)));
  temps.push(home!, projectRoot!);
  mkdirSync(join(projectRoot!, ".git"));
  return { home: home!, projectRoot: projectRoot! };
}
async function cli(dirs: { home: string; projectRoot: string } | undefined, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, installDirs: dirs });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("install", () => {
  it("installs the skills under their own names for each harness, and uninstall takes them back out", async () => {
    const dirs = installDirs();
    const install = await cli(dirs, "install", "--local", "--harness", "claude,codex", "--yes");
    expect(install.err).toBe("");
    expect(install.code).toBe(0);
    for (const skills of [".claude/skills", ".agents/skills"]) {
      for (const name of SKILLS) {
        const skill = readFileSync(join(dirs.projectRoot, skills, name, "SKILL.md"), "utf8");
        expect(skill).toContain(`name: ${name}\n`);
      }
      expect(existsSync(join(dirs.projectRoot, skills, "read-feedback/references/connecting.md"))).toBe(true);
    }
    expect(existsSync(join(dirs.home, ".claude"))).toBe(false);

    expect((await cli(dirs, "status")).out).toMatch(/Project .*mcp-feedback \d+\.\d+\.\d+ for claude, codex/);

    expect((await cli(dirs, "uninstall", "--local", "--yes")).code).toBe(0);
    for (const skills of [".claude/skills", ".agents/skills"]) {
      expect(existsSync(join(dirs.projectRoot, skills, "read-feedback"))).toBe(false);
    }
  });

  it("asks for a scope it cannot prompt for", async () => {
    const { code, err } = await cli(installDirs(), "install", "--harness", "claude");
    expect(code).toBe(2);
    expect(err).toMatch(/--user .*--local/);
  });

  it("points setup at install", async () => {
    const { code, err } = await cli(undefined, "setup", "--dir", "skills");
    expect(code).toBe(2);
    expect(err).toMatch(/install --local/);
  });
});

describe("agentdist.json", () => {
  it("states the package's version, and the committed plugin manifests are what it generates", () => {
    const pkg = loadPackage(repo);
    const { version } = JSON.parse(readFileSync(join(repo, "packages/typescript/package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(version);
    // Run `pnpm gen:plugins` after changing agentdist.json or adding a skill.
    expect(runPack(pkg, PACK_TARGETS, { check: true }).changes.filter((change: { change: string }) => change.change !== "unchanged")).toEqual([]);
  });
});
