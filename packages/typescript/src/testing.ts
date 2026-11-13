import assert from "node:assert/strict";
import { conformanceCases, conformanceRecords, type StoreCase } from "./conformance-cases.js";
import type { FeedbackStore } from "./store.js";

export { conformanceCases, conformanceRecords, type StoreCase };

async function runCase(store: FeedbackStore, testCase: StoreCase): Promise<void> {
  switch (testCase.op) {
    case "list": {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list({ ...testCase.filter, limit: testCase.limit, cursor });
        pages.push(page.items.map((item) => item.id));
        cursor = page.next_cursor ?? undefined;
        assert.ok(pages.length <= testCase.expect_pages.length, "store returned more pages than expected");
      } while (cursor);
      assert.deepEqual(pages, testCase.expect_pages);
      return;
    }
    case "get": {
      const expected = conformanceRecords.find((record) => record.id === testCase.id) ?? null;
      assert.equal(expected !== null, testCase.expect_found);
      assert.deepEqual(await store.get(testCase.id), expected);
      return;
    }
    case "stats":
      assert.deepEqual(await store.stats(testCase.filter), testCase.expect);
      return;
    case "insert_duplicate": {
      const existing = conformanceRecords.find((record) => record.id === testCase.id)!;
      await assert.rejects(store.insert(existing), "inserting an existing id must reject");
      return;
    }
    case "update_triage": {
      const updated = await store.updateTriage(testCase.id, testCase.patch);
      if (testCase.expect === null) {
        assert.equal(updated, null);
        return;
      }
      assert.ok(updated, "updateTriage must resolve the updated record");
      const reread = await store.get(testCase.id);
      assert.deepEqual(reread, updated);
      for (const [key, value] of Object.entries(testCase.expect)) {
        assert.deepEqual(updated[key as keyof typeof updated], value, key);
      }
      return;
    }
  }
}

/**
 * Checks a store against the contract in spec/store-contract.md. Pass a store
 * that is empty; the suite seeds it. Rejects with the first failing case.
 */
export async function runStoreConformance(store: FeedbackStore): Promise<void> {
  // Seed out of order so a store cannot pass by returning insertion order.
  for (const index of [3, 0, 5, 2, 1, 4]) await store.insert(structuredClone(conformanceRecords[index]!));
  for (const testCase of conformanceCases) {
    try {
      await runCase(store, testCase);
    } catch (error) {
      throw new Error(`Store conformance failed: ${testCase.name}`, { cause: error });
    }
  }
}
