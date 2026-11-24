// `mcp-feedback setup`: copies the agent skills that ship with the package into a project's skills
// directory, so sessions working in that project have them without installing a plugin. With --plugin
// it instead turns the Claude Code plugin on for the project, for projects worked on only in Claude Code.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FeedbackInputError } from "./reader.js";

/** Records what setup wrote, so a later run can tell its own files from ones edited since. */
const MANIFEST = ".mcp-feedback.json";
const SKILL_DIRS = [".agents/skills", ".claude/skills"];
/** The Claude Code marketplace this repository serves, and the plugin in it. */
const MARKETPLACE = { name: "mcp-feedback", repo: "krishchow/feedback" };
const PLUGIN = `mcp-feedback@${MARKETPLACE.name}`;

export interface SetupOptions {
  cwd: string;
  /** Install here instead of detecting the project's skills directories. */
  dir?: string;
  /** Replace files that were edited after an earlier setup, or that setup did not write. */
  force?: boolean;
  dryRun?: boolean;
  /** Turn the Claude Code plugin on in the project's settings instead of copying the skills. */
  plugin?: boolean;
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

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Adds the marketplace and the plugin to the project's .claude/settings.json, leaving everything else in
 * it alone. Nothing is copied: Claude Code fetches the skills from the repository.
 */
function setupPlugin(options: SetupOptions): number {
  const root = projectRoot(options.cwd);
  const path = join(root, ".claude", "settings.json");
  const shown = relative(options.cwd, path) || path;
  let settings: Json = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new FeedbackInputError(`${shown} is not valid JSON (${(error as Error).message}); nothing was changed.`);
    }
    if (!isObject(parsed)) throw new FeedbackInputError(`${shown} does not hold a JSON object; nothing was changed.`);
    settings = parsed;
  }
  const marketplaces = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const enabled = isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const registered = MARKETPLACE.name in marketplaces && enabled[PLUGIN] === true;

  if (registered) {
    options.out(`${shown} already turns on ${PLUGIN}`);
  } else {
    // An entry the project already has for the marketplace is kept as it is. autoUpdate makes installed
    // copies follow the repository; Claude Code leaves it off for marketplaces that are not its own.
    const next = {
      ...settings,
      extraKnownMarketplaces: {
        ...marketplaces,
        [MARKETPLACE.name]: marketplaces[MARKETPLACE.name] ?? {
          source: { source: "github", repo: MARKETPLACE.repo },
          autoUpdate: true,
        },
      },
      enabledPlugins: { ...enabled, [PLUGIN]: true },
    };
    if (!options.dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    }
    options.out(`${options.dryRun ? "would turn on" : "turned on"} ${PLUGIN} in ${shown}`);
  }

  const seen = new Set<string>();
  const copies = SKILL_DIRS.map((dir) => join(root, dir)).filter((dir) => {
    if (!existsSync(join(dir, MANIFEST))) return false;
    const real = realpathSync(dir);
    return !seen.has(real) && seen.add(real);
  });
  if (copies.length) {
    const where = copies.map((dir) => relative(options.cwd, dir) || ".");
    options.out(`warning: the skills were also copied into ${where.join(" and ")}; Claude Code will list each one twice.`);
    options.out("         Keep one: remove those copies, or take the plugin back out of the settings file.");
  } else if ([".agents", "AGENTS.md"].some((name) => existsSync(join(root, name)))) {
    options.out("warning: this project is also set up for agents other than Claude Code, and they get nothing from a plugin.");
    options.out("         Run setup without --plugin to copy the skills in for them.");
  }
  options.out("");
  options.out("Commit the settings file. Claude Code does not download the plugin by itself, so everyone");
  options.out("working in this project, you included, runs this once in their copy of it:");
  options.out(`  claude plugin install ${PLUGIN} --scope project`);
  return 0;
}

/** Copies the skills into the project, or turns the plugin on, and resolves the process exit code. */
export function setupSkills(options: SetupOptions): number {
  if (options.plugin) return setupPlugin(options);
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
