import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defaultResolveIdentity,
  type FeedbackRequestExtra,
  type ResolveIdentity,
} from "./identity.js";
import { FeedbackInputError, listPage, normalizeFilter, triageMany } from "./reader.js";
import type { FeedbackStore } from "./store.js";
import {
  READER_TOOLS,
  SUBMIT_TOOL,
  submitToolDescription,
  SYNTHESIZE_PROMPT,
  feedbackStatsShape,
  getFeedbackShape,
  listFeedbackShape,
  submitFeedbackShape,
  synthesizeFeedbackArgsShape,
  synthesizePromptText,
  updateFeedbackTriageShape,
} from "./tools.js";
import {
  FEEDBACK_SCHEMA_VERSION,
  type FeedbackContext,
  type FeedbackIdentity,
  type FeedbackRecord,
  type FeedbackServerInfo,
} from "./types.js";

export interface FeedbackLimits {
  titleChars: number;
  bodyChars: number;
  excerptChars: number;
  /** Every other free-text field: context strings, tool call fields, repro steps, tags. */
  fieldChars: number;
  /** Maximum entries in tags, tool_calls and repro_steps. */
  maxItems: number;
  /** Maximum size of context.metadata once serialised as JSON. */
  metadataBytes: number;
}

export const DEFAULT_FEEDBACK_LIMITS: FeedbackLimits = {
  titleChars: 200,
  bodyChars: 8000,
  excerptChars: 8000,
  fieldChars: 4000,
  maxItems: 50,
  metadataBytes: 16384,
};

interface SharedOptions {
  /** Created once at module level and shared across requests. */
  store: FeedbackStore;
  /** Maps a request onto an identity; overrides what the default resolver finds. */
  resolveIdentity?: ResolveIdentity;
  /** Prepended to every tool and prompt name, e.g. `"meme_"`. */
  toolPrefix?: string;
  /**
   * Secret for HMAC token fingerprints. Recommended; without it fingerprints are plain SHA-256.
   * Use the same key everywhere that writes or compares fingerprints, and keep it stable.
   */
  tokenFingerprintKey?: string;
  /** Called with unexpected (non-validation) errors, for the host's logger. */
  onError?: (error: unknown, tool: string) => void;
}

export interface FeedbackOptions extends SharedOptions {
  /**
   * Tell agents to file only after the user confirms the exact feedback. Pair it with
   * `feedbackConfirmInstructions` in the server's instructions.
   */
  requireConfirmation?: boolean;
  /** Refuse submissions that carry neither a subject nor a token fingerprint. */
  requireIdentity?: boolean;
  /** Last chance to scrub a record before it is stored. */
  redact?: (record: FeedbackRecord) => FeedbackRecord | Promise<FeedbackRecord>;
  limits?: Partial<FeedbackLimits>;
  /** Recorded on each record. Defaults to the name and version the server was constructed with. */
  serverInfo?: Partial<FeedbackServerInfo>;
}

export interface FeedbackReaderOptions extends SharedOptions {
  /** Leave out `update_feedback_triage`, so the reader can look but not change anything. */
  readOnly?: boolean;
}


type SubmitInput = {
  kind: FeedbackRecord["kind"];
  title: string;
  body: string;
  severity?: FeedbackRecord["severity"];
  tags?: string[];
  context?: FeedbackContext;
};

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function checkLimits(input: SubmitInput, limits: FeedbackLimits): void {
  const text = (label: string, value: string | undefined, max: number) => {
    if (value !== undefined && value.length > max) {
      throw new FeedbackInputError(`${label} is ${value.length} characters; the limit is ${max}. Shorten it and resubmit.`);
    }
  };
  const items = (label: string, value: unknown[] | undefined) => {
    if (value !== undefined && value.length > limits.maxItems) {
      throw new FeedbackInputError(`${label} has ${value.length} entries; the limit is ${limits.maxItems}.`);
    }
  };

  for (const field of ["title", "body"] as const) {
    if (!input[field].trim()) throw new FeedbackInputError(`${field} is blank. Describe the problem and resubmit.`);
  }
  text("title", input.title, limits.titleChars);
  text("body", input.body, limits.bodyChars);
  items("tags", input.tags);
  input.tags?.forEach((tag, index) => text(`tags[${index}]`, tag, limits.fieldChars));

  const context = input.context ?? {};
  text("context.excerpt", context.excerpt, limits.excerptChars);
  for (const field of ["goal", "expected", "actual", "workaround", "suggestion"] as const) {
    text(`context.${field}`, context[field], limits.fieldChars);
  }
  items("context.repro_steps", context.repro_steps);
  context.repro_steps?.forEach((step, index) => text(`context.repro_steps[${index}]`, step, limits.fieldChars));
  items("context.tool_calls", context.tool_calls);
  context.tool_calls?.forEach((call, index) => {
    text(`context.tool_calls[${index}].name`, call.name, limits.fieldChars);
    text(`context.tool_calls[${index}].arguments_summary`, call.arguments_summary, limits.fieldChars);
    text(`context.tool_calls[${index}].error`, call.error, limits.fieldChars);
  });
  if (context.metadata !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(context.metadata), "utf8");
    if (bytes > limits.metadataBytes) {
      throw new FeedbackInputError(`context.metadata is ${bytes} bytes as JSON; the limit is ${limits.metadataBytes}.`);
    }
  }
}

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function config<Shape>(
  tool: { title: string; description: string; annotations: Record<string, boolean> },
  inputSchema: Shape,
) {
  return { title: tool.title, description: tool.description, annotations: tool.annotations, inputSchema };
}

function createRuntime(server: McpServer, options: SharedOptions) {
  const prefix = options.toolPrefix ?? "";

  const identify = async (extra: FeedbackRequestExtra): Promise<FeedbackIdentity> => {
    const defaults = defaultResolveIdentity(extra, server.server.getClientVersion(), options.tokenFingerprintKey);
    return options.resolveIdentity ? { ...defaults, ...(await options.resolveIdentity(extra, defaults)) } : defaults;
  };

  const guard = async (tool: string, run: () => Promise<Record<string, unknown>>) => {
    try {
      return result(await run());
    } catch (error) {
      if (!(error instanceof FeedbackInputError)) options.onError?.(error, tool);
      const text = error instanceof FeedbackInputError ? error.message : "The feedback store is unavailable. Try again later.";
      return { isError: true, content: [{ type: "text" as const, text }] };
    }
  };

  return { prefix, identify, guard };
}

/** Adds `submit_feedback` to a server. Safe to call on a server built per request. */
export function registerFeedback(server: McpServer, options: FeedbackOptions): void {
  const { prefix, identify, guard } = createRuntime(server, options);
  const limits = { ...DEFAULT_FEEDBACK_LIMITS, ...options.limits };
  const name = prefix + SUBMIT_TOOL.name;

  server.registerTool(
    name,
    {
      title: SUBMIT_TOOL.title,
      description: submitToolDescription(options.requireConfirmation),
      inputSchema: submitFeedbackShape,
      annotations: SUBMIT_TOOL.annotations,
    },
    (args, extra) =>
      guard(name, async () => {
        const input = args as SubmitInput;
        checkLimits(input, limits);

        const identity = await identify(extra);
        if (options.requireIdentity && !identity.subject && !identity.token_fingerprint) {
          throw new FeedbackInputError("Feedback was not recorded: this server only accepts it from authenticated callers.");
        }

        // The SDK does not expose the server's own name and version publicly; tests cover this
        // fallback, and hosts can avoid it by passing serverInfo.
        const constructed = (server.server as unknown as { _serverInfo?: Partial<FeedbackServerInfo> })._serverInfo;
        const now = new Date();
        const created = now.toISOString();
        let record: FeedbackRecord = {
          schema_version: FEEDBACK_SCHEMA_VERSION,
          id: uuidv7(now.getTime()),
          created_at: created,
          kind: input.kind,
          title: input.title,
          body: input.body,
          severity: input.severity ?? "none",
          tags: [...new Set(input.tags ?? [])],
          context: JSON.parse(JSON.stringify(input.context ?? {})) as FeedbackContext,
          identity,
          server: {
            name: options.serverInfo?.name ?? constructed?.name ?? null,
            version: options.serverInfo?.version ?? constructed?.version ?? null,
          },
          status: "new",
          triage_note: null,
          triaged_by: null,
          updated_at: created,
        };
        if (options.redact) record = await options.redact(record);

        await options.store.insert(record);
        return { id: record.id, created_at: record.created_at, status: record.status };
      }),
  );
}

/**
 * Adds the reader tools and the `synthesize_feedback` prompt. Mount these only
 * on a server or endpoint restricted to the people and agents allowed to read
 * everyone's feedback.
 */
export function registerFeedbackReader(server: McpServer, options: FeedbackReaderOptions): void {
  const { prefix, identify, guard } = createRuntime(server, options);
  const { store } = options;
  const names = {
    list: prefix + READER_TOOLS.list.name,
    get: prefix + READER_TOOLS.get.name,
    triage: prefix + READER_TOOLS.triage.name,
    stats: prefix + READER_TOOLS.stats.name,
  };

  server.registerTool(
    names.list,
    config(READER_TOOLS.list, listFeedbackShape),
    (args) =>
      guard(names.list, async () => {
        const page = await listPage(store, args);
        return { ...page };
      }),
  );

  server.registerTool(names.get, config(READER_TOOLS.get, getFeedbackShape), (args) =>
    guard(names.get, async () => {
      const record = await store.get(args.id);
      if (!record) throw new FeedbackInputError(`No feedback with id ${args.id}.`);
      return { ...record };
    }),
  );

  if (!options.readOnly) {
    server.registerTool(names.triage, config(READER_TOOLS.triage, updateFeedbackTriageShape), (args, extra) =>
      guard(names.triage, async () => {
        const reader = await identify(extra);
        const outcome = await triageMany(store, args.ids, {
          status: args.status,
          note: args.note,
          by: reader.subject ?? reader.client_id ?? reader.token_fingerprint,
        });
        return { ...outcome };
      }),
    );
  }

  server.registerTool(names.stats, config(READER_TOOLS.stats, feedbackStatsShape), (args) =>
    guard(names.stats, async () => ({ ...(await store.stats(normalizeFilter(args))) })),
  );

  server.registerPrompt(
    prefix + SYNTHESIZE_PROMPT.name,
    {
      title: SYNTHESIZE_PROMPT.title,
      description: SYNTHESIZE_PROMPT.description,
      argsSchema: synthesizeFeedbackArgsShape,
    },
    (args) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: synthesizePromptText(prefix, args) } }],
    }),
  );
}
