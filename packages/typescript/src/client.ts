// Reads and triages feedback through a server's reader tools, so maintainers
// need the reader endpoint's credential rather than database access.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { READER_TOOLS } from "./tools.js";
import { FeedbackReaderError, type FeedbackReaderClient } from "./reader.js";

export { FeedbackReaderError, type FeedbackReaderClient };

/** The reader tools cap a page at this size; larger requests are clamped and continue by cursor. */
export const READER_PAGE_LIMIT = 100;

const HTTP_HINTS: Record<number, string> = {
  401: "the credential is missing or was refused",
  403: "the credential is not allowed to use this endpoint",
  404: "no MCP endpoint at this URL",
  405: "no MCP endpoint at this URL",
};

export interface FeedbackReaderClientOptions {
  /** Streamable HTTP URL of the endpoint that has the reader tools mounted. */
  url: string | URL;
  /** Sent on every request, e.g. `{ Authorization: "Bearer …" }`. */
  headers?: Record<string, string>;
  /** The server's toolPrefix, if it set one. */
  toolPrefix?: string;
}

export async function connectFeedbackReader(options: FeedbackReaderClientOptions): Promise<FeedbackReaderClient> {
  const url = new URL(options.url);
  const prefix = options.toolPrefix ?? "";
  const client = new Client({ name: "mcp-feedback", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: options.headers } }));
  } catch (error) {
    // The SDK's StreamableHTTPError carries the HTTP status as `code`.
    const status = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : undefined;
    const reason = status !== undefined && HTTP_HINTS[status] ? `HTTP ${status}, ${HTTP_HINTS[status]}` : error instanceof Error ? error.message : String(error);
    throw new FeedbackReaderError(`Could not connect to ${url}: ${reason}.`, status);
  }

  const call = async <T>(tool: { name: string }, args: Record<string, unknown>): Promise<T> => {
    const name = prefix + tool.name;
    // An unknown tool usually means the server registered the reader tools with a prefix.
    // SDK versions differ on whether that arrives as a thrown error or an error result.
    const fail = (message: string) =>
      new FeedbackReaderError(/Tool \S+ not found/.test(message) ? `${message}. If the server uses a tool prefix, pass it.` : message);
    let response;
    try {
      response = await client.callTool({ name, arguments: args });
    } catch (error) {
      throw fail(error instanceof Error ? error.message : String(error));
    }
    const text = (response.content as Array<{ type: string; text?: string }> | undefined)?.find((c) => c.type === "text")?.text;
    if (response.isError) throw fail(text ?? `${name} failed.`);
    return (response.structuredContent ?? JSON.parse(text ?? "null")) as T;
  };

  return {
    stats: (filter) => call(READER_TOOLS.stats, { ...filter }),
    list: ({ limit, ...rest }) => call(READER_TOOLS.list, { ...rest, limit: Math.min(limit, READER_PAGE_LIMIT) }),
    get: (id) => call(READER_TOOLS.get, { id }),
    triage: (ids, change) => call(READER_TOOLS.triage, { ids, status: change.status, note: change.note }),
    close: () => client.close(),
  };
}
