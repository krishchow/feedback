// `mcp-feedback install`, `uninstall`, `status` and `harnesses`: the agent skills that ship with the package,
// installed into a project's or the user's agent harnesses by agentdist, from the agentdist.json beside them.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realEnv, runCli } from "agentdist";
import type { CliIo } from "./cli.js";

/** The published package's root, which holds agentdist.json and the skills, or the repository's in a checkout. */
function packageRoot(): string {
  const candidates = ["..", "../../.."].map((path) => fileURLToPath(new URL(path, import.meta.url)));
  const found = candidates.find((path) => existsSync(join(path, "agentdist.json")));
  if (!found) throw new Error("agentdist.json is missing from this copy of mcp-feedback.");
  return found;
}

/** Hands the command to agentdist and resolves the process exit code. */
export async function installCli(argv: string[], io: CliIo): Promise<number> {
  // agentdist writes whole lines, ending in a newline; io.out and io.err add their own.
  const line = (write: (line: string) => void) => (text: string) => write(text.replace(/\n$/, ""));
  return runCli({
    packageRoot: packageRoot(),
    argv,
    bin: "npx mcp-feedback",
    env: io.installDirs && realEnv({ ...io.installDirs, vars: io.env }),
    stdout: line(io.out),
    stderr: line(io.err),
  });
}
