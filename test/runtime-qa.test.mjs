import test from "node:test";
import assert from "node:assert/strict";
import { snapshotStream } from "../dist/realtime.js";
import { PlatformError } from "../dist/client.js";
import { rollbackMigration, hash } from "../dist/migration.js";
import {
  executeCutover,
  assessCutover,
  CUTOVER_GATES,
} from "../dist/cutover.js";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { WorkflowEngine } from "../dist/workflows.js";
import { WorkflowSchedules } from "../dist/schedules.js";

test("runtime QA: an unread stream stops before fetching another snapshot", async () => {
  let reads = 0;
  const response = await snapshotStream(
    new Request("https://example.test/events"),
    async () => ({ sequence: ++reads }),
    { intervalMs: 50, maxDurationMs: 500 },
  );
  await delay(140);
  assert.equal(reads, 1);
  const text = await response.text();
  assert.equal((text.match(/event: snapshot/g) || []).length, 1);
});

test(
  "runtime QA: MySQL workers isolate apps, versions and scheduler names",
  { skip: !process.env.TEST_MYSQL_URL },
  async () => {
    const pool = mysql.createPool(process.env.TEST_MYSQL_URL);
    const appA = "qa-" + randomUUID(),
      appB = "qa-" + randomUUID();
    const scope = (appId) => ({ appId, user: { id: "synthetic-owner" } });
    const definition = (version) => ({
      version,
      authorize: () => true,
      run: async () => ({ ok: true }),
    });
    const engine = (appId, defs) =>
      new WorkflowEngine(pool, appId, defs, async () => ({
        id: "synthetic-owner",
      }));
    const a = engine(appA, { job: definition("1") }),
      a2 = engine(appA, { job: definition("2") }),
      b = engine(appB, { job: definition("1") });
    try {
      await a.migrate();
      const other = await b.enqueue(
        scope(appB),
        "job",
        {},
        { idempotencyKey: "other" },
      );
      const different = await a2.enqueue(
        scope(appA),
        "job",
        {},
        { idempotencyKey: "different" },
      );
      const own = await a.enqueue(
        scope(appA),
        "job",
        {},
        { idempotencyKey: "own" },
      );
      await pool.execute(
        "UPDATE platform_workflows SET status='running',attempts=max_attempts,lease_until=0 WHERE id=?",
        [other.id],
      );
      assert.equal(await a.tick(), true);
      assert.equal((await a.get(scope(appA), own.id)).status, "completed");
      assert.equal((await a2.get(scope(appA), different.id)).attempts, 0);
      assert.equal((await b.get(scope(appB), other.id)).status, "running");
      assert.equal(await a.tick(), false);
      const schedules = new WorkflowSchedules(a),
        otherSchedules = new WorkflowSchedules(b);
      const unknownSchedules = new WorkflowSchedules(
        engine(appA, { other: definition("1") }),
      );
      await schedules.migrate();
      const spec = { intervalMs: 1000, anchorAt: 0 };
      const otherSchedule = await otherSchedules.create(
        scope(appB),
        "job",
        spec,
      );
      const unknownSchedule = await unknownSchedules.create(
        scope(appA),
        "other",
        spec,
      );
      await pool.execute(
        "UPDATE platform_schedules SET next_at=0 WHERE id IN (?,?)",
        [otherSchedule.id, unknownSchedule.id],
      );
      assert.equal(await schedules.tick(), false);
      const [rows] = await pool.execute(
        "SELECT paused,next_at FROM platform_schedules WHERE id IN (?,?)",
        [otherSchedule.id, unknownSchedule.id],
      );
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => !row.paused && Number(row.next_at) === 0));
    } finally {
      await pool.execute(
        "DELETE FROM platform_schedules WHERE app_id IN (?,?)",
        [appA, appB],
      );
      await pool.execute(
        "DELETE FROM platform_workflows WHERE app_id IN (?,?)",
        [appA, appB],
      );
      await pool.end();
    }
  },
);

test("runtime QA: revoked stream emits an error and closes before another snapshot", async () => {
  let reads = 0;
  const response = await snapshotStream(
    new Request("https://example.test/events"),
    async () => {
      if (++reads > 1) throw new PlatformError("Unauthorized", 401);
      return [{ id: "fixture", value: "visible" }];
    },
    { intervalMs: 50, maxDurationMs: 150 },
  );
  const frames = await response.text();
  assert.equal((frames.match(/event: snapshot/g) || []).length, 1);
  assert.match(frames, /event: error/);
  assert.equal(reads, 2);
});

test("runtime QA: rollback preflight refuses changed imports before deleting any row", async () => {
  const calls = [];
  const c = {
    async beginTransaction() {},
    async execute(sql, args) {
      calls.push(sql);
      return [
        [
          {
            document: {
              id: args[2],
              value: args[2] === "changed" ? "edited" : "original",
            },
          },
        ],
      ];
    },
    async rollback() {
      calls.push("rollback");
    },
    async commit() {
      calls.push("commit");
    },
    release() {},
  };
  const receipt = {
    appId: "runtime-qa",
    planDigest: "synthetic",
    inserted: ["unchanged", "changed"].map((id) => ({
      entity: "Item",
      id,
      hash: hash({ id, value: "original" }),
    })),
  };
  await assert.rejects(
    rollbackMigration({ getConnection: async () => c }, receipt),
    /rollback refused/,
  );
  assert.ok(calls.includes("rollback"));
  assert.ok(!calls.some((sql) => sql.startsWith("DELETE") || sql === "commit"));
});

test("runtime QA: failed target and failed restoration return recovery_required", async () => {
  const plan = {
    appId: "runtime-qa",
    source: "synthetic-source",
    target: "synthetic-target",
    writesFrozen: true,
    evidence: CUTOVER_GATES.map((gate) => ({
      gate,
      passed: true,
      reference: "synthetic-test",
      checkedAt: new Date().toISOString(),
    })),
  };
  const calls = [];
  const result = await executeCutover(plan, assessCutover(plan).digest, {
    switchTraffic: async () => {
      calls.push("switch");
    },
    verifyTarget: async () => false,
    restoreTraffic: async () => {
      calls.push("restore");
      throw Error("Synthetic restoration failure");
    },
    verifySource: async () => {
      calls.push("verifySource");
      return true;
    },
  });
  assert.equal(result.status, "recovery_required");
  assert.deepEqual(calls, ["switch", "restore"]);
});
