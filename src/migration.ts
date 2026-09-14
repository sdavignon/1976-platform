import { createHash } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { PlatformError, type Data } from "./client.js";
import type { EntityDefinition, Policy } from "./mysql.js";
import { canonical } from "./workflows.js";
export interface MigrationBundle {
  formatVersion: 1;
  sourceAppId: string;
  entities: Record<string, { schema: Data; records: Data[] }>;
}
export interface MigrationPlan {
  appId: string;
  bundleHash: string;
  targetHash: string;
  digest: string;
  insertCount: number;
  unchangedCount: number;
  conflicts: string[];
}
export interface MigrationReceipt {
  appId: string;
  planDigest: string;
  inserted: { entity: string; id: string; hash: string }[];
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const validName = (name: string) => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name);
export function schemaValidator(schema: Data) {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: true,
  });
  (addFormats as unknown as (a: Ajv) => void)(ajv);
  const normalized = structuredClone(schema);
  delete normalized.name;
  delete normalized.rls;
  const validate = ajv.compile(normalized);
  return (data: Data) => {
    if (!validate(data))
      throw new PlatformError(
        "Schema validation failed: " + ajv.errorsText(validate.errors),
        400,
        "SCHEMA_VALIDATION",
      );
  };
}
/** Base44 RLS is deliberately not interpreted as executable policy. */
export function defineEntities(
  schemas: Record<string, Data>,
  policies: Record<string, Policy>,
): Record<string, EntityDefinition> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => {
      if (
        !validName(name) ||
        !Object.hasOwn(policies, name) ||
        typeof policies[name] !== "function"
      )
        throw new Error(`Explicit policy required: ${name}`);
      return [
        name,
        { authorize: policies[name], validate: schemaValidator(schema) },
      ];
    }),
  );
}
function validateBundle(bundle: MigrationBundle) {
  if (
    bundle.formatVersion !== 1 ||
    !bundle.sourceAppId ||
    !bundle.entities ||
    Array.isArray(bundle.entities) ||
    !Object.keys(bundle.entities).length
  )
    throw new Error("Invalid migration bundle");
  for (const [entity, { schema, records }] of Object.entries(bundle.entities)) {
    if (!validName(entity) || !Array.isArray(records))
      throw new Error("Invalid entity bundle");
    const validate = schemaValidator(schema),
      seen = new Set<string>();
    for (const record of records) {
      if (
        !record ||
        typeof record.id !== "string" ||
        !record.id.length ||
        record.id.length > 36 ||
        seen.has(record.id.toLowerCase())
      )
        throw new Error(`Invalid or duplicate id in ${entity}`);
      seen.add(record.id.toLowerCase());
      validate(record);
    }
  }
}
const decode = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
async function target(
  c: Pool | PoolConnection,
  appId: string,
  names: string[],
  lock = false,
) {
  const [rows] = await c.execute<any[]>(
    `SELECT entity,id,document FROM platform_records WHERE app_id=? AND entity IN (${names.map(() => "?").join(",")}) ORDER BY entity,id${lock ? " FOR UPDATE" : ""}`,
    [appId, ...names],
  );
  return rows.map((r) => ({
    entity: r.entity,
    id: r.id,
    document: decode(r.document),
  }));
}
function planFor(
  appId: string,
  bundle: MigrationBundle,
  rows: { entity: string; id: string; document: Data }[],
): MigrationPlan {
  const existing = new Map(
    rows.map((r) => [r.entity + "\0" + r.id, r.document]),
  );
  const conflicts: string[] = [];
  let insertCount = 0,
    unchangedCount = 0;
  for (const [entity, { records }] of Object.entries(bundle.entities))
    for (const record of records) {
      const old = existing.get(entity + "\0" + record.id);
      if (!old) insertCount++;
      else if (hash(old) === hash(record)) unchangedCount++;
      else conflicts.push(entity + "/" + record.id);
    }
  const bundleHash = hash(bundle),
    targetHash = hash(rows),
    digest = hash({ appId, bundleHash, targetHash });
  return {
    appId,
    bundleHash,
    targetHash,
    digest,
    insertCount,
    unchangedCount,
    conflicts,
  };
}
export async function planMigration(
  pool: Pool,
  appId: string,
  bundle: MigrationBundle,
) {
  validateBundle(bundle);
  if (!appId || appId.length > 100) throw new Error("Target appId required");
  return planFor(
    appId,
    bundle,
    await target(pool, appId, Object.keys(bundle.entities)),
  );
}
/** Trusted operator API. Atomic insert-only import; never overwrites an existing record. */
export async function applyMigration(
  pool: Pool,
  appId: string,
  bundle: MigrationBundle,
  expectedDigest: string,
): Promise<MigrationReceipt> {
  validateBundle(bundle);
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const rows = await target(c, appId, Object.keys(bundle.entities), true),
      plan = planFor(appId, bundle, rows);
    if (plan.digest !== expectedDigest)
      throw new Error(
        "Migration plan changed; generate and review a fresh plan",
      );
    if (plan.conflicts.length)
      throw new Error("Conflicting records; no writes performed");
    const existing = new Set(rows.map((r) => r.entity + "\0" + r.id)),
      inserted: MigrationReceipt["inserted"] = [];
    for (const [entity, { records }] of Object.entries(bundle.entities))
      for (const record of records) {
        if (existing.has(entity + "\0" + record.id)) continue;
        await c.execute(
          "INSERT INTO platform_records (app_id,entity,id,document) VALUES (?,?,?,?)",
          [appId, entity, record.id, JSON.stringify(record)],
        );
        inserted.push({ entity, id: record.id, hash: hash(record) });
      }
    await c.commit();
    return { appId, planDigest: plan.digest, inserted };
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function rollbackMigration(pool: Pool, receipt: MigrationReceipt) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    for (const item of receipt.inserted) {
      const [rows] = await c.execute<any[]>(
        "SELECT document FROM platform_records WHERE app_id=? AND entity=? AND id=? FOR UPDATE",
        [receipt.appId, item.entity, item.id],
      );
      if (rows.length && hash(decode(rows[0].document)) !== item.hash)
        throw new Error("Imported record changed; rollback refused");
    }
    for (const item of receipt.inserted)
      await c.execute(
        "DELETE FROM platform_records WHERE app_id=? AND entity=? AND id=?",
        [receipt.appId, item.entity, item.id],
      );
    await c.commit();
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export async function verifyMigration(
  pool: Pool,
  appId: string,
  bundle: MigrationBundle,
) {
  validateBundle(bundle);
  const rows = await target(pool, appId, Object.keys(bundle.entities));
  const actual = new Map(rows.map((r) => [r.entity + "\0" + r.id, r.document]));
  const missing: string[] = [],
    different: string[] = [];
  for (const [entity, { records }] of Object.entries(bundle.entities))
    for (const record of records) {
      const key = entity + "\0" + record.id,
        value = actual.get(key);
      if (!value) missing.push(entity + "/" + record.id);
      else if (hash(value) !== hash(record))
        different.push(entity + "/" + record.id);
      actual.delete(key);
    }
  return {
    ok: !missing.length && !different.length && !actual.size,
    missing,
    different,
    extra: [...actual.keys()].map((k) => k.replace("\0", "/")),
  };
}
export async function exportData(
  pool: Pool,
  appId: string,
  schemas: Record<string, Data>,
): Promise<MigrationBundle> {
  if (
    !Object.keys(schemas).length ||
    Object.keys(schemas).some((n) => !validName(n))
  )
    throw new Error("Explicit schemas required");
  const c = await pool.getConnection();
  try {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await c.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const rows = await target(c, appId, Object.keys(schemas));
    const entities = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        {
          schema,
          records: rows.filter((r) => r.entity === name).map((r) => r.document),
        },
      ]),
    );
    await c.commit();
    return { formatVersion: 1, sourceAppId: appId, entities };
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
