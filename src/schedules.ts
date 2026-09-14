import { CronExpressionParser } from "cron-parser";
import { createHash, randomUUID } from "node:crypto";
import type { Scope } from "./mysql.js";
import type {
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowContext,
} from "./workflows.js";
import { PlatformError, type Data } from "./client.js";
export type ScheduleSpec =
  { cron: string; timezone: string } | { intervalMs: number; anchorAt: number };
export function nextOccurrence(spec: ScheduleSpec, after: number): number {
  if ("cron" in spec) {
    new Intl.DateTimeFormat("en", { timeZone: spec.timezone });
    return CronExpressionParser.parse(spec.cron, {
      currentDate: new Date(after),
      tz: spec.timezone,
    })
      .next()
      .getTime();
  }
  if (
    !Number.isSafeInteger(spec.intervalMs) ||
    spec.intervalMs < 1000 ||
    !Number.isSafeInteger(spec.anchorAt)
  )
    throw new Error("Invalid interval");
  return (
    spec.anchorAt +
    Math.max(0, Math.floor((after - spec.anchorAt) / spec.intervalMs) + 1) *
      spec.intervalMs
  );
}
/** Scheduled jobs are inserted and schedule advancement committed in one transaction. */
export class WorkflowSchedules {
  constructor(readonly engine: WorkflowEngine) {}
  async migrate() {
    await this.engine.pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_schedules (id VARCHAR(36) PRIMARY KEY,app_id VARCHAR(100) NOT NULL,owner_id VARCHAR(100) NOT NULL,name VARCHAR(100) NOT NULL,spec JSON NOT NULL,input JSON NOT NULL,next_at BIGINT NOT NULL,paused BOOLEAN NOT NULL DEFAULT FALSE)`,
    );
  }
  async create(
    scope: Scope,
    name: string,
    spec: ScheduleSpec,
    input: Data = {},
  ) {
    if (scope.appId !== this.engine.appId)
      throw new PlatformError("Wrong workflow application", 403);
    const definition = Object.hasOwn(this.engine.definitions, name)
      ? this.engine.definitions[name]
      : undefined;
    if (
      !scope.user ||
      !definition ||
      !(await definition.authorize(scope, input))
    )
      throw new PlatformError("Forbidden", 403);
    const id = randomUUID();
    await this.engine.pool.execute(
      "INSERT INTO platform_schedules (id,app_id,owner_id,name,spec,input,next_at) VALUES (?,?,?,?,?,?,?)",
      [
        id,
        scope.appId,
        scope.user.id,
        name,
        JSON.stringify(spec),
        JSON.stringify(input),
        nextOccurrence(spec, Date.now()),
      ],
    );
    return { id };
  }
  async pause(scope: Scope, id: string) {
    if (!scope.user) throw new PlatformError("Unauthorized", 401);
    await this.engine.pool.execute(
      "UPDATE platform_schedules SET paused=TRUE WHERE id=? AND app_id=? AND owner_id=?",
      [id, scope.appId, scope.user.id],
    );
  }
  async tick(): Promise<boolean> {
    const names = Object.keys(this.engine.definitions);
    if (!names.length) return false;
    const c = await this.engine.pool.getConnection();
    try {
      await c.beginTransaction();
      const now = Date.now();
      const [rows] = await c.execute<any[]>(
        `SELECT * FROM platform_schedules WHERE app_id=? AND name IN (${names.map(() => "?").join(",")}) AND paused=FALSE AND next_at<=? ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [this.engine.appId, ...names, now],
      );
      if (!rows.length) {
        await c.commit();
        return false;
      }
      const row = rows[0],
        decode = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
      const input = decode(row.input),
        spec = decode(row.spec),
        scope: Scope = {
          appId: row.app_id,
          user: await this.engine.resolveUser(row.app_id, row.owner_id),
        },
        definition = Object.hasOwn(this.engine.definitions, row.name)
          ? this.engine.definitions[row.name]
          : undefined;
      if (
        !definition ||
        !scope.user ||
        !(await definition.authorize(scope, input))
      ) {
        await c.execute(
          "UPDATE platform_schedules SET paused=TRUE WHERE id=?",
          [row.id],
        );
        await c.commit();
        return true;
      }
      const dedupe = createHash("sha256")
        .update("schedule:" + row.id + ":" + row.next_at)
        .digest("hex");
      await c.execute(
        `INSERT INTO platform_workflows (id,app_id,owner_id,name,version,dedupe,input,status,max_attempts,due_at) VALUES (?,?,?,?,?,?,?,'queued',3,?) ON DUPLICATE KEY UPDATE id=id`,
        [
          randomUUID(),
          row.app_id,
          row.owner_id,
          row.name,
          definition.version,
          dedupe,
          JSON.stringify(input),
          now,
        ],
      );
      await c.execute("UPDATE platform_schedules SET next_at=? WHERE id=?", [
        nextOccurrence(spec, now),
        row.id,
      ]);
      await c.commit();
      return true;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
  }
}
/** Converts the static sequential subset used by the inspected Base44 workflow files. */
export function compileBase44Workflow(
  source: Data,
  authorize: WorkflowDefinition["authorize"],
  invoke: (
    name: string,
    args: Data,
    context: WorkflowContext,
    idempotencyKey: string,
  ) => Promise<unknown>,
): { name: string; definition: WorkflowDefinition; schedule: ScheduleSpec } {
  const trigger = source.trigger?.config,
    document = source.definition?.document,
    steps = source.definition?.do;
  if (
    source.trigger?.condition ||
    trigger?.trigger_type !== "scheduled" ||
    trigger.ends_type !== "never" ||
    !Array.isArray(steps) ||
    !steps.length ||
    !document?.name
  )
    throw new Error("Unsupported workflow DSL");
  const entries = steps.map((entry: Data) => {
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw new Error("One operation per step required");
    return { name: keys[0], value: entry[keys[0]] };
  });
  if (new Set(entries.map((e) => e.name)).size !== entries.length)
    throw new Error("Duplicate workflow step");
  for (let i = 0; i < entries.length; i++) {
    const { value } = entries[i];
    if (
      value.call !== "invoke_backend_function" ||
      typeof value.with?.function_name !== "string" ||
      value.then !== (entries[i + 1]?.name ?? "end") ||
      JSON.stringify(value.with.args ?? {}).includes("${")
    )
      throw new Error("Only static ordered backend calls are supported");
  }
  let schedule: ScheduleSpec;
  if (trigger.schedule_mode === "recurring")
    schedule = {
      cron: trigger.cron_expression,
      timezone: trigger.timezone ?? "UTC",
    };
  else if (trigger.schedule_mode === "interval") {
    const units: Record<string, number> = {
      seconds: 1000,
      minutes: 60000,
      hours: 3600000,
      days: 86400000,
    };
    let anchor = trigger.interval_anchor;
    if (typeof anchor !== "string") throw new Error("Interval anchor required");
    if (!/(Z|[+-]\d\d:\d\d)$/.test(anchor)) {
      if (trigger.timezone !== "UTC")
        throw new Error("Ambiguous local interval anchor");
      anchor += "Z";
    }
    schedule = {
      intervalMs: trigger.interval_value * units[trigger.interval_unit],
      anchorAt: Date.parse(anchor),
    };
  } else throw new Error("Unsupported schedule mode");
  nextOccurrence(schedule, Date.now());
  return {
    name: document.name,
    schedule,
    definition: {
      version: String(document.version ?? "1"),
      authorize,
      run: async (_input, context) => {
        let result: unknown;
        for (const step of entries)
          result = await context.step(step.name, (key) =>
            invoke(
              step.value.with.function_name,
              step.value.with.args ?? {},
              context,
              key,
            ),
          );
        return result;
      },
    },
  };
}
