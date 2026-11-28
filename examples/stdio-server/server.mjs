// A stdio MCP server, the kind that runs on its users' machines (npx, a CLI). It has no database a
// maintainer could read, so feedback goes to the maintainer's ingest hub instead. On a hub with open
// enrolment (`ingest serve --open`) it only names its project. On one without, set EXAMPLE_PROJECT_KEY
// to the output of
//   mcp-feedback ingest issue-key --project example --key key.json --issuer https://feedback.example.com
// which is public by design: it can only enrol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { feedbackConfirmInstructions, registerFeedback } from "mcp-feedback";
import { feedbackEndpoint, remoteStore } from "mcp-feedback/remote";
import { z } from "zod";

// EXAMPLE_FEEDBACK_ENDPOINT if set, otherwise the hub this server ships. Undefined, and no feedback
// tool, when the user sets MCP_FEEDBACK_DISABLED=1. Leave out `fallback` to send nothing unless the
// person running the server names a hub (here or in the shared MCP_FEEDBACK_ENDPOINT).
const FEEDBACK_ENDPOINT = feedbackEndpoint({ variable: "EXAMPLE_FEEDBACK_ENDPOINT", fallback: "https://feedback.example.com" });
const PROJECT_KEY = process.env.EXAMPLE_PROJECT_KEY;
const PROJECT = process.env.EXAMPLE_PROJECT ?? "example";

const server = new McpServer(
  { name: "example-stdio", version: "1.0.0" },
  { instructions: `Use echo to repeat text. ${FEEDBACK_ENDPOINT ? feedbackConfirmInstructions : ""}` },
);
server.registerTool("echo", { description: "Repeat text.", inputSchema: { text: z.string() } }, ({ text }) => ({
  content: [{ type: "text", text }],
}));

// Users can turn feedback off; the tool is then not offered at all.
if (FEEDBACK_ENDPOINT) {
  const store = remoteStore({
    endpoint: FEEDBACK_ENDPOINT,
    ...(PROJECT_KEY ? { projectKey: PROJECT_KEY } : { project: PROJECT }),
    // Users of a real server keep the default, a per-user state directory.
    stateDir: process.env.EXAMPLE_STATE_DIR,
    onError: (error) => console.error("feedback:", error instanceof Error ? error.message : error),
  });
  registerFeedback(server, {
    store,
    requireConfirmation: true,
    destination: "the example-stdio maintainers",
    attachContext: () => ({ node: process.version, platform: process.platform }),
  });
  // Renews this machine's token if it is a day old, and sends reports that could not go last time,
  // without holding up startup. It contacts the hub only if this machine has used feedback before.
  void store.start();
}

await server.connect(new StdioServerTransport());
