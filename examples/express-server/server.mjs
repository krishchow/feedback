// A stateless Streamable HTTP server that builds a new McpServer per request,
// with the feedback tools dropped in. Two endpoints, two tokens:
//   POST /mcp           agents: the server's own tools + submit_feedback
//   POST /mcp/feedback  maintainers: the reader tools only

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { feedbackInstructions, registerFeedback, registerFeedbackReader } from "mcp-feedback";
import { sqliteStore } from "mcp-feedback/sqlite";
import { z } from "zod";

export function createApp({ agentToken, readerToken, dbPath }) {
  // One store for the life of the process; it opens the file on first use.
  const store = sqliteStore({ path: dbPath });

  // Setting req.auth is what makes extra.authInfo available to tool handlers,
  // and so what ties each feedback record to the caller.
  const bearer = (token, clientId) => (req, res, next) => {
    if (req.get("authorization") !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
    req.auth = { token, clientId, scopes: [] };
    next();
  };

  const serve = (build) => async (req, res) => {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const app = express();
  app.use(express.json());

  app.post(
    "/mcp",
    bearer(agentToken, "example-agent"),
    serve(() => {
      const server = new McpServer(
        { name: "example", version: "1.0.0" },
        { instructions: `Use echo to repeat text. ${feedbackInstructions}` },
      );
      server.registerTool("echo", { description: "Repeat text.", inputSchema: { text: z.string() } }, ({ text }) => ({
        content: [{ type: "text", text }],
      }));
      registerFeedback(server, { store, onError: (error, tool) => console.error(tool, error) });
      return server;
    }),
  );

  app.post(
    "/mcp/feedback",
    bearer(readerToken, "example-maintainer"),
    serve(() => {
      const server = new McpServer({ name: "example-feedback", version: "1.0.0" });
      registerFeedbackReader(server, { store, onError: (error, tool) => console.error(tool, error) });
      return server;
    }),
  );

  return { app, store };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { AGENT_TOKEN: agentToken, READER_TOKEN: readerToken, PORT = "3000" } = process.env;
  if (!agentToken || !readerToken) throw new Error("Set AGENT_TOKEN and READER_TOKEN");
  createApp({ agentToken, readerToken, dbPath: process.env.FEEDBACK_DB ?? "./feedback.db" }).app.listen(Number(PORT), () =>
    console.log(`listening on :${PORT}`),
  );
}
