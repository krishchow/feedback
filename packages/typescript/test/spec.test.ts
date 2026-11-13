// Keeps spec/ and the TypeScript implementation in step. Run `pnpm gen:spec`
// to regenerate the derived spec files after changing tools, vectors or DDL.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { feedbackInstructions, memoryStore, registerFeedback, registerFeedbackReader } from "../src/index.js";
import { schemaStatements } from "../src/stores/sql.js";
import { conformanceCases, conformanceRecords } from "../src/testing.js";
import { call, connect } from "./helpers.js";

const specPath = (file: string) => fileURLToPath(new URL(`../../../spec/${file}`, import.meta.url));
const update = process.env.UPDATE_SPEC === "1";

function expectSpecFile(file: string, content: string) {
  if (update) writeFileSync(specPath(file), content);
  expect(readFileSync(specPath(file), "utf8"), `${file} is stale; run pnpm gen:spec`).toBe(content);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("spec", () => {
  it("tools.json matches what the servers advertise", async () => {
    const store = memoryStore();
    const submit = await connect((server) => registerFeedback(server, { store }));
    const reader = await connect((server) => registerFeedbackReader(server, { store }));
    const tools = async (client: typeof submit) =>
      (await client.listTools()).tools.map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        annotations,
        inputSchema,
      }));

    expectSpecFile(
      "tools.json",
      json({
        spec_version: 1,
        instructions: feedbackInstructions,
        submit_tools: await tools(submit),
        reader_tools: await tools(reader),
        reader_prompts: (await reader.listPrompts()).prompts.map(({ name, title, description, arguments: args }) => ({
          name,
          title,
          description,
          arguments: args,
        })),
      }),
    );
  });

  it("conformance/store-cases.json matches the vectors", () => {
    expectSpecFile("conformance/store-cases.json", json({ spec_version: 1, records: conformanceRecords, cases: conformanceCases }));
  });

  it("sql/*.sql match the DDL the stores run", () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      expectSpecFile(`sql/${dialect}.sql`, `${schemaStatements(dialect, "mcp_feedback").join(";\n\n")};\n`);
    }
  });

  it("records validate against feedback-record.schema.json", async () => {
    const validate = new Ajv2020.default({ allErrors: true }).compile(
      JSON.parse(readFileSync(specPath("feedback-record.schema.json"), "utf8")),
    );
    const check = (record: unknown) => expect(validate(record), JSON.stringify(validate.errors)).toBe(true);

    conformanceRecords.forEach(check);

    const store = memoryStore();
    const client = await connect((server) => registerFeedback(server, { store }), {
      token: "t".repeat(40),
      clientId: "c",
      scopes: [],
    });
    const minimal = await call(client, "submit_feedback", { kind: "praise", title: "Nice", body: "It worked." });
    check(await store.get(minimal.data!.id));

    expect(validate({ ...conformanceRecords[0], status: "open" })).toBe(false);
    expect(validate({ ...conformanceRecords[0], identity: undefined })).toBe(false);
    expect(validate({ ...conformanceRecords[0], extra_field: 1 })).toBe(false);
  });
});
