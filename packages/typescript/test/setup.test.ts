import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

const dirs: string[] = [];
function project(setup: (root: string) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-feedback-setup-"));
  dirs.push(root);
  mkdirSync(join(root, ".git"));
  setup(root);
  return root;
}
async function setup(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const code = await runCli(["setup", ...argv], { out: (l) => out.push(l), err: (l) => out.push(l), env: {}, cwd });
  return { code, text: out.join("\n") };
}
const skill = (root: string, dir: string) => join(root, dir, "read-feedback", "SKILL.md");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setup", () => {
  it("installs every skill into .agents/skills when the project has no skills directory", async () => {
    const root = project();
    const { code, text } = await setup(root);
    expect(code).toBe(0);
    for (const name of ["add-feedback-to-mcp-server", "read-feedback", "set-up-feedback-reading"]) {
      expect(existsSync(join(root, ".agents/skills", name, "SKILL.md"))).toBe(true);
    }
    expect(existsSync(join(root, ".agents/skills/read-feedback/references/connecting.md"))).toBe(true);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(text).toMatch(/installed into \.agents\/skills: \d+ added, 0 updated, 0 unchanged/);
  });

  it("uses the skills directories the project already has, from a subdirectory too", async () => {
    const root = project((dir) => {
      mkdirSync(join(dir, ".claude/skills"), { recursive: true });
      mkdirSync(join(dir, "packages/api"), { recursive: true });
    });
    expect((await setup(join(root, "packages/api"))).code).toBe(0);
    expect(existsSync(skill(root, ".claude/skills"))).toBe(true);
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  it("follows the agent the project is set up for, and writes once when one directory links to the other", async () => {
    const claude = project((dir) => writeFileSync(join(dir, "CLAUDE.md"), ""));
    await setup(claude);
    expect(existsSync(skill(claude, ".claude/skills"))).toBe(true);

    const linked = project((dir) => {
      mkdirSync(join(dir, ".agents/skills"), { recursive: true });
      mkdirSync(join(dir, ".claude"));
      symlinkSync("../.agents/skills", join(dir, ".claude/skills"));
    });
    const { text } = await setup(linked);
    expect(text.match(/installed into/g)).toHaveLength(1);
    expect(existsSync(skill(linked, ".claude/skills"))).toBe(true);
  });

  it("updates its own files on a later run but keeps ones changed in the project", async () => {
    const root = project();
    await setup(root);
    const target = skill(root, ".agents/skills");
    const original = readFileSync(target, "utf8");
    expect((await setup(root)).text).toMatch(/0 added, 0 updated, \d+ unchanged/);

    writeFileSync(target, "edited here");
    const kept = await setup(root);
    expect(kept.code).toBe(1);
    expect(kept.text).toMatch(/kept .*read-feedback\/SKILL\.md/);
    expect(readFileSync(target, "utf8")).toBe("edited here");

    expect((await setup(root, "--force")).code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original);

    // A file still exactly as an earlier version of the package wrote it is replaced without --force.
    const manifestPath = join(root, ".agents/skills/.mcp-feedback.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(target, "an older release's text");
    manifest.files["read-feedback/SKILL.md"] = "e2b78fd6b1eb0ffc4ec7c2ef0e9b22a34d0d7cf2e4d1c0d1fb05cf0ad25b2a5d";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect((await setup(root)).code).toBe(1);
    const { createHash } = await import("node:crypto");
    manifest.files["read-feedback/SKILL.md"] = createHash("sha256").update("an older release's text").digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const updated = await setup(root);
    expect(updated.code).toBe(0);
    expect(updated.text).toMatch(/1 updated/);
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("honours --dir and --dry-run, and rejects its flags on other commands", async () => {
    const root = project();
    expect((await setup(root, "--dry-run")).text).toMatch(/would install into \.agents\/skills/);
    expect(existsSync(join(root, ".agents"))).toBe(false);
    await setup(root, "--dir", "tools/skills");
    expect(existsSync(skill(root, "tools/skills"))).toBe(true);
    expect(await runCli(["stats", "--force"], { out: () => {}, err: () => {}, env: {} })).toBe(2);
  });
});
