// A stdio MCP server, the kind that runs on its users' machines (npx, a CLI). It has no database a
// maintainer could read, so feedback goes to the maintainer's ingest hub instead:
//   mcp-feedback ingest keygen --out key.json
//   mcp-feedback ingest issue-key --project example --key key.json --issuer https://feedback.example.com
// and paste the printed project key below. It is public by design; it can only enrol.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { feedbackConfirmInstructions, registerFeedback } from "mcp-feedback";
import { feedbackDisabled, remoteStore } from "mcp-feedback/remote";
import { z } from "zod";

const FEEDBACK_ENDPOINT = process.env.EXAMPLE_FEEDBACK_ENDPOINT ?? "https://feedback.example.com";
const PROJECT_KEY = process.env.EXAMPLE_PROJECT_KEY ?? "<the output of mcp-feedback ingest issue-key>";

const server = new McpServer(
  { name: "example-stdio", version: "1.0.0" },
  { instructions: `Use echo to repeat text. ${feedbackDisabled() ? "" : feedbackConfirmInstructions}` },
);
server.registerTool("echo", { description: "Repeat text.", inputSchema: { text: z.string() } }, ({ text }) => ({
  content: [{ type: "text", text }],
}));

// Users can turn feedback off; the tool is then not offered at all.
if (!feedbackDisabled()) {
  const store = remoteStore({
    endpoint: FEEDBACK_ENDPOINT,
    projectKey: PROJECT_KEY,
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
  // Reports that could not be sent last time go now, without holding up startup.
  void store.flush();
}

await server.connect(new StdioServerTransport());
