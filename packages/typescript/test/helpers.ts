import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
