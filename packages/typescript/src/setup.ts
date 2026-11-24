// `mcp-feedback setup`: copies the agent skills that ship with the package into a project's skills
// directory, so sessions working in that project have them without installing a plugin.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FeedbackInputError } from "./reader.js";

/** Records what setup wrote, so a later run can tell its own files from ones edited since. */
const MANIFEST = ".mcp-feedback.json";
const SKILL_DIRS = [".agents/skills", ".claude/skills"];

export interface SetupOptions {
  cwd: string;
  /** Install here instead of detecting the project's skills directories. */
  dir?: string;
  /** Replace files that were edited after an earlier setup, or that setup did not write. */
  force?: boolean;
  dryRun?: boolean;
  version: string;
  /** Test seam: where the skills are read from. */
  skillsSource?: string;
  out: (line: string) => void;
}

/** The skills bundled with the published package, or the repository's own when run from a checkout. */
function bundledSkills(): string {
  const candidates = ["../skills", "../../../skills"].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  const found = candidates.find((path) => existsSync(join(path, "read-feedback", "SKILL.md")));
  if (!found) throw new Error("The skills are missing from this copy of mcp-feedback.");
  return found;
}

/** The nearest directory at or above `from` that holds a .git, else `from`. */
function projectRoot(from: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return resolve(from);
  }
}

/**
 * Where the project keeps skills. Every skills directory it already has gets a copy (once, when one is a
 * link to the other). With none, the choice follows which agent the project is already set up for.
 */
function targets(root: string): string[] {
  const existing = SKILL_DIRS.map((dir) => join(root, dir)).filter((dir) => existsSync(dir));
  if (existing.length) {
    const seen = new Set<string>();
    return existing.filter((dir) => {
      const real = realpathSync(dir);
      return !seen.has(real) && seen.add(real);
    });
  }
  const has = (...names: string[]) => names.some((name) => existsSync(join(root, name)));
  const wanted = [has(".agents", "AGENTS.md") && ".agents/skills", has(".claude", "CLAUDE.md") && ".claude/skills"].filter(
    (dir): dir is string => Boolean(dir),
  );
  return (wanted.length ? wanted : [".agents/skills"]).map((dir) => join(root, dir));
}

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();
}

const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");

/** Copies the skills into the project and resolves the process exit code. */
export function setupSkills(options: SetupOptions): number {
  const source = options.skillsSource ?? bundledSkills();
  const root = projectRoot(options.cwd);
  const destinations = options.dir ? [resolve(options.cwd, options.dir)] : targets(root);
  const files = filesUnder(source);
  let kept = 0;

  for (const destination of destinations) {
    if (existsSync(destination) && !statSync(destination).isDirectory()) {
      throw new FeedbackInputError(`${destination} is not a directory.`);
    }
    const manifestPath = join(destination, MANIFEST);
    const installed: Record<string, string> = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: Record<string, string> }).files ?? {}
      : {};
    const written: Record<string, string> = {};
    const counts = { added: 0, updated: 0, unchanged: 0 };

    for (const file of files) {
      const content = readFileSync(join(source, file));
      const wanted = hash(content);
      const target = join(destination, file);
      const current = existsSync(target) ? hash(readFileSync(target)) : undefined;
      if (current === wanted) {
        counts.unchanged++;
        written[file] = wanted;
        continue;
      }
      // A file that differs is replaced only if it is still exactly what an earlier setup wrote.
      if (current !== undefined && current !== installed[file] && !options.force) {
        kept++;
        if (installed[file]) written[file] = installed[file];
        options.out(`  kept     ${relative(options.cwd, target) || target}  (changed here; --force replaces it)`);
        continue;
      }
      if (!options.dryRun) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      written[file] = wanted;
      counts[current === undefined ? "added" : "updated"]++;
    }

    if (!options.dryRun && (counts.added || counts.updated || !existsSync(manifestPath))) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(manifestPath, `${JSON.stringify({ package: "mcp-feedback", version: options.version, files: written }, null, 2)}\n`);
    }
    options.out(
      `${options.dryRun ? "would install into" : "installed into"} ${relative(options.cwd, destination) || "."}: ` +
        `${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged`,
    );
  }

  const skills = [...new Set(files.map((file) => file.split("/")[0]!))];
  options.out(`skills: ${skills.join(", ")}`);
  options.out("");
  options.out("Next, in an agent session in this project:");
  options.out('  "Add agent feedback to this MCP server"            if it does not collect feedback yet');
  options.out('  "Set this project up for reading its feedback"     once it does; this writes the project\'s own reference');
  options.out('  "Summarize the feedback agents have filed"         from then on');
  options.out("Run this again after upgrading mcp-feedback to update the skills.");
  return kept ? 1 : 0;
}
