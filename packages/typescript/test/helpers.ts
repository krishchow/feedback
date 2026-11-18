import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerFeedbackReader, type FeedbackStore } from "../src/index.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Connects a client to a server in memory, optionally as an authenticated caller. */
export async function connect(configure: (server: McpServer) => void, authInfo?: AuthInfo): Promise<Client> {
  const server = new McpServer({ name: "test-server", version: "9.9.9" });
  configure(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (authInfo) {
    // Stands in for the HTTP transport, which copies req.auth onto each message.
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, { ...options, authInfo });
  }

  const client = new Client({ name: "test-client", version: "1.2.3" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as Array<{ type: string; text: string }>;
  return {
    isError: response.isError === true,
    text: content[0]?.text ?? "",
    data: response.structuredContent as Record<string, any> | undefined,
  };
}

export const READER_TOKEN = "reader-token";

// A stateless Streamable HTTP reader endpoint, as a host would mount it.
export async function readerEndpoint(store: FeedbackStore, toolPrefix?: string) {
  const http: Server = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${READER_TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    (req as typeof req & { auth?: unknown }).auth = { token: READER_TOKEN, clientId: "maintainers", scopes: [], extra: { sub: "reader" } };
    const server = new McpServer({ name: "reader", version: "1.0.0" });
    registerFeedbackReader(server, { store, toolPrefix });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, close: () => new Promise((r) => http.close(r)) };
}

