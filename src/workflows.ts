import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { PlatformError, type Data } from "./client.js";
import type { Scope } from "./mysql.js";

export interface WorkflowContext extends Scope {
  runId: string;
  signal: AbortSignal;
  step<T>(
    name: string,
    work: (idempotencyKey: string) => Promise<T>,
  ): Promise<T>;
}
export interface WorkflowDefinition {
  version: string;
  authorize: (scope: Scope, input: Data) => boolean | Promise<boolean>;
  run: (input: Data, context: WorkflowContext) => Promise<unknown>;
}
const json = (value: any) =>
  typeof value === "string" ? JSON.parse(value) : value;
/** Durable at-least-once queue. Run workers separately from HTTP requests. */
export class WorkflowEngine {
  constructor(
    readonly pool: Pool,
    readonly appId: string,
    readonly definitions: Record<string, WorkflowDefinition>,
    readonly resolveUser: (
      appId: string,
      userId: string,
    ) => Promise<Scope["user"]>,
  ) {
    if (!appId) throw new Error("Worker appId required");
  }
  async migrate() {
    await this.pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_workflows (id VARCHAR(36) PRIMARY KEY, app_id VARCHAR(100) NOT NULL, owner_id VARCHAR(100) NOT NULL, name VARCHAR(100) NOT NULL, version VARCHAR(100) NOT NULL, dedupe VARCHAR(64) NOT NULL, input JSON NOT NULL, status VARCHAR(20) NOT NULL, attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL, due_at BIGINT NOT NULL, lease_until BIGINT NULL, lease_token VARCHAR(36) NULL, result JSON NULL, UNIQUE KEY dedupe_run(app_id,owner_id,dedupe), KEY runnable(status,due_at))`,
    );
    await this.pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_workflow_steps (run_id VARCHAR(36) NOT NULL, name VARCHAR(100) NOT NULL, result JSON NOT NULL, PRIMARY KEY(run_id,name))`,
    );
  }
  async enqueue(
    scope: Scope,
    name: string,
    input: Data,
    options: { idempotencyKey: string; delayMs?: number; maxAttempts?: number },
  ) {
    if (scope.appId !== this.appId)
      throw new PlatformError("Wrong workflow application", 403);
    const definition = Object.hasOwn(this.definitions, name)
      ? this.definitions[name]
      : undefined;
    if (!definition) throw new PlatformError("Unknown workflow", 404);
    if (!scope.user || !(await definition.authorize(scope, input)))
      throw new PlatformError("Forbidden", 403);
    const delay = options.delayMs ?? 0,
      max = options.maxAttempts ?? 3;
    if (
      !options.idempotencyKey ||
      options.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > 20
    )
      throw new PlatformError("Invalid workflow options", 400);
    const dedupe = createHash("sha256")
        .update(name + "\0" + options.idempotencyKey)
        .digest("hex"),
      id = randomUUID();
    await this.pool.execute(
      `INSERT INTO platform_workflows (id,app_id,owner_id,name,version,dedupe,input,status,max_attempts,due_at) VALUES (?,?,?,?,?,?,?,'queued',?,?) ON DUPLICATE KEY UPDATE id=id`,
      [
        id,
        scope.appId,
        scope.user.id,
        name,
        definition.version,
        dedupe,
        JSON.stringify(input),
        max,
        Date.now() + delay,
      ],
    );
    const [rows] = await this.pool.execute<any[]>(
      "SELECT * FROM platform_workflows WHERE app_id=? AND owner_id=? AND dedupe=?",
      [scope.appId, scope.user.id, dedupe],
    );
    const run = rows[0];
    if (
      run.version !== definition.version ||
      JSON.stringify(json(run.input)) !==
        JSON.stringify(json(JSON.stringify(input)))
    ) {
      // JSON column key ordering is normalized by MySQL; use a canonical comparison.
      if (
        run.version !== definition.version ||
        canonical(json(run.input)) !== canonical(input)
      )
        throw new PlatformError(
          "Idempotency key already used with different input or version",
          409,
        );
    }
    return this.get(scope, run.id);
  }
  async get(scope: Scope, id: string) {
    const [rows] = await this.pool.execute<any[]>(
      "SELECT * FROM platform_workflows WHERE app_id=? AND id=?",
      [scope.appId, id],
    );
    const row = rows[0];
    if (!row) throw new PlatformError("Workflow not found", 404);
    if (!scope.user || row.owner_id !== scope.user.id)
      throw new PlatformError("Forbidden", 403);
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      attempts: row.attempts,
      result: json(row.result),
    };
  }
  /** A tick claims at most one job. Multiple processes may call tick concurrently. */
  async tick(leaseMs = 30000): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 300)
      throw new Error("leaseMs must be >=300");
    const definitions = Object.entries(this.definitions);
    if (!definitions.length) return false;
    const eligible =
      "app_id=? AND (" +
      definitions.map(() => "(name=? AND version=?)").join(" OR ") +
      ")";
    const eligibility = [
      this.appId,
      ...definitions.flatMap(([name, d]) => [name, d.version]),
    ];
    const c = await this.pool.getConnection();
    let row: any,
      token = randomUUID();
    try {
      await c.beginTransaction();
      await c.execute(
        `UPDATE platform_workflows SET status='failed',lease_token=NULL WHERE ${eligible} AND status='running' AND lease_until<? AND attempts>=max_attempts`,
        [...eligibility, Date.now()],
      );
      const [rows] = await c.execute<any[]>(
        `SELECT * FROM platform_workflows WHERE ${eligible} AND ((status='queued' AND due_at<=?) OR (status='running' AND lease_until<?)) AND attempts<max_attempts ORDER BY due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [...eligibility, Date.now(), Date.now()],
      );
      row = rows[0];
      if (!row) {
        await c.commit();
        return false;
      }
      await c.execute(
        "UPDATE platform_workflows SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?",
        [token, Date.now() + leaseMs, row.id],
      );
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    const abort = new AbortController();
    let renewing = false;
    const heartbeat = setInterval(
      async () => {
        if (renewing) return;
        renewing = true;
        try {
          const [r] = await this.pool.execute<any>(
            "UPDATE platform_workflows SET lease_until=? WHERE id=? AND lease_token=? AND status='running' AND lease_until>=?",
            [Date.now() + leaseMs, row.id, token, Date.now()],
          );
          if (!r.affectedRows) abort.abort();
        } catch {
          abort.abort();
        } finally {
          renewing = false;
        }
      },
      Math.floor(leaseMs / 3),
    );
    try {
      const definition = Object.hasOwn(this.definitions, row.name)
        ? this.definitions[row.name]
        : undefined;
      const scope: Scope = {
        appId: row.app_id,
        user: await this.resolveUser(row.app_id, row.owner_id),
      };
      if (
        !definition ||
        definition.version !== row.version ||
        !scope.user ||
        !(await definition.authorize(scope, json(row.input)))
      )
        throw new Error("Workflow configuration or authorization changed");
      const result = await definition.run(json(row.input), {
        ...scope,
        runId: row.id,
        signal: abort.signal,
        step: async (name, work) => {
          if (!/^[\w.-]{1,100}$/.test(name) || abort.signal.aborted)
            throw new Error("Invalid step or lost lease");
          const [cached] = await this.pool.execute<any[]>(
            "SELECT result FROM platform_workflow_steps WHERE run_id=? AND name=?",
            [row.id, name],
          );
          if (cached.length) return json(cached[0].result);
          const value = await work(`${row.id}:${name}`);
          // Fence cache writes with the current lease, not just the run ID.
          const [saved] = await this.pool.execute<any>(
            `INSERT INTO platform_workflow_steps (run_id,name,result) SELECT id,?,? FROM platform_workflows WHERE id=? AND lease_token=? AND status='running' AND lease_until>=? ON DUPLICATE KEY UPDATE result=platform_workflow_steps.result`,
            [name, JSON.stringify(value ?? null), row.id, token, Date.now()],
          );
          if (!saved.affectedRows) throw new Error("Lost workflow lease");
          return value;
        },
      });
      await this.pool.execute(
        "UPDATE platform_workflows SET status='completed',result=?,lease_token=NULL WHERE id=? AND lease_token=? AND lease_until>=?",
        [JSON.stringify(result ?? null), row.id, token, Date.now()],
      );
    } catch {
      await this.pool.execute(
        "UPDATE platform_workflows SET status=IF(attempts>=max_attempts,'failed','queued'),due_at=?,lease_token=NULL WHERE id=? AND lease_token=?",
        [Date.now() + Math.min(60000, 1000 * 2 ** row.attempts), row.id, token],
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
