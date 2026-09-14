import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { PlatformError, type Data } from "./client.js";
export type Principal = { id: string; email?: string; role?: string };
export type Scope = {
  appId: string;
  user: Principal | null;
  service?: boolean;
};
export type Policy = (
  context: Scope & {
    entity: string;
    operation: string;
    record: Data | null;
    data?: Data;
  },
) => boolean | Promise<boolean>;
export interface EntityDefinition {
  authorize: Policy;
  validate?: (data: Data) => void;
}
const bad = (message: string): never => {
  throw new PlatformError(message, 400, "INVALID_INPUT");
};
const name = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(value)
    ? value
    : bad("Invalid field or entity name");
const bounded = (value: unknown, fallback: number, max: number) => {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || Number(n) < 0 || Number(n) > max)
    bad("Invalid pagination");
  return Number(n);
};
/** Compile a small, explicit Mongo-style filter subset into bound MySQL JSON predicates. */
export function compileFilter(
  query: Data,
  depth = 0,
): { sql: string; params: any[] } {
  if (!query || typeof query !== "object" || Array.isArray(query) || depth > 8)
    return bad("Invalid filter");
  const parts: string[] = [],
    params: any[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (key === "$or" || key === "$and") {
      if (!Array.isArray(value) || value.length === 0 || value.length > 100)
        bad("Invalid logical filter");
      const children = (value as Data[]).map((v) =>
        compileFilter(v, depth + 1),
      );
      parts.push(
        "(" +
          children.map((c) => c.sql).join(key === "$or" ? " OR " : " AND ") +
          ")",
      );
      params.push(...children.flatMap((c) => c.params));
      continue;
    }
    const field = `JSON_EXTRACT(document, '$.${name(key)}')`;
    const ops =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value)
        : [["$eq", value]];
    if (!ops.length) bad("Empty operator");
    for (const [operator, arg] of ops) {
      if (operator === "$in" || operator === "$nin") {
        if (!Array.isArray(arg) || arg.length > 100)
          bad("Invalid inclusion filter");
        parts.push(
          arg.length
            ? `${field} ${operator === "$in" ? "IN" : "NOT IN"} (${arg.map(() => "CAST(? AS JSON)").join(",")})`
            : operator === "$in"
              ? "FALSE"
              : "TRUE",
        );
        params.push(...(arg as unknown[]).map((v) => JSON.stringify(v)));
        continue;
      }
      const op: Record<string, string> = {
        $eq: "=",
        $ne: "<>",
        $gt: ">",
        $gte: ">=",
        $lt: "<",
        $lte: "<=",
      };
      if (!op[operator]) bad("Unsupported filter operator");
      parts.push(`${field} ${op[operator]} CAST(? AS JSON)`);
      params.push(JSON.stringify(arg));
    }
  }
  return { sql: parts.join(" AND ") || "TRUE", params };
}
const reserved = new Set([
  "id",
  "created_date",
  "updated_date",
  "created_by",
  "app_id",
]);
function clean(data: Data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    bad("Object required");
  for (const k of Object.keys(data))
    if (reserved.has(k)) bad(`Server-managed field: ${k}`);
  return data;
}
export class MySQLStore {
  readonly pool: Pool;
  constructor(
    connection: string | Pool,
    readonly entities: Record<string, EntityDefinition>,
  ) {
    this.pool =
      typeof connection === "string"
        ? mysql.createPool(connection)
        : connection;
  }
  async migrate() {
    await this.pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_records (app_id VARCHAR(100) NOT NULL, entity VARCHAR(100) NOT NULL, id VARCHAR(36) NOT NULL, document JSON NOT NULL, PRIMARY KEY(app_id,entity,id))`,
    );
  }
  async close() {
    await this.pool.end();
  }
  async execute(
    scope: Scope,
    entity: string,
    operation: string,
    args: Data = {},
  ) {
    name(entity);
    if (!scope.appId || scope.appId.length > 100) bad("Invalid appId");
    const definition = Object.hasOwn(this.entities, entity)
      ? this.entities[entity]
      : undefined;
    if (!definition) throw new PlatformError("Unknown entity", 404);
    const allowed = async (record: Data | null, data?: Data) =>
      scope.service === true ||
      (await definition.authorize({
        ...scope,
        entity,
        operation,
        record,
        data,
      })) === true;
    const requireAccess = async (record: Data | null, data?: Data) => {
      if (!(await allowed(record, data)))
        throw new PlatformError("Forbidden", 403);
    };
    if (operation === "filter") {
      const filter = compileFilter(args.query ?? {}),
        limit = bounded(args.limit, 50, 1000),
        skip = bounded(args.skip, 0, 100000);
      const sort = args.sort ?? "-created_date";
      if (typeof sort !== "string") bad("Invalid sort");
      const descending = sort.startsWith("-"),
        field = name(descending ? sort.slice(1) : sort);
      if (
        args.fields !== undefined &&
        (!Array.isArray(args.fields) ||
          args.fields.some((f: unknown) => typeof f !== "string"))
      )
        bad("Invalid fields");
      // Authorization precedes pagination. Never leak forbidden records or underfill pages by post-filtering a SQL LIMIT.
      const [rows] = await this.pool.execute<any[]>(
        `SELECT document FROM platform_records WHERE app_id=? AND entity=? AND ${filter.sql} ORDER BY JSON_EXTRACT(document, '$.${field}') ${descending ? "DESC" : "ASC"}, id ASC`,
        [scope.appId, entity, ...filter.params],
      );
      const visible: Data[] = [];
      for (const row of rows) {
        const record =
          typeof row.document === "string"
            ? JSON.parse(row.document)
            : row.document;
        if (await allowed(record)) visible.push(record);
      }
      return visible
        .slice(skip, skip + limit)
        .map((r) =>
          args.fields
            ? Object.fromEntries(
                ["id", ...args.fields]
                  .filter((f) => Object.hasOwn(r, f))
                  .map((f) => [f, r[f]]),
              )
            : r,
        );
    }
    if (
      !["get", "create", "update", "delete", "bulkCreate"].includes(operation)
    )
      throw new PlatformError("Unsupported operation", 400);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      let result: any;
      const create = async (data: Data) => {
        clean(data);
        await requireAccess(null, data);
        definition.validate?.(data);
        const now = new Date().toISOString();
        const record = {
          ...data,
          id: randomUUID(),
          created_date: now,
          updated_date: now,
          created_by: scope.user?.email ?? scope.user?.id ?? "service",
        };
        await connection.execute(
          "INSERT INTO platform_records (app_id,entity,id,document) VALUES (?,?,?,?)",
          [scope.appId, entity, record.id, JSON.stringify(record)],
        );
        return record;
      };
      if (operation === "create") result = await create(args.data);
      else if (operation === "bulkCreate") {
        if (!Array.isArray(args.data) || args.data.length > 1000)
          bad("Invalid bulk create");
        result = [];
        for (const data of args.data) result.push(await create(data));
      } else {
        if (typeof args.id !== "string" || args.id.length > 100)
          bad("Invalid id");
        const [rows] = await connection.execute<any[]>(
          "SELECT document FROM platform_records WHERE app_id=? AND entity=? AND id=? FOR UPDATE",
          [scope.appId, entity, args.id],
        );
        if (!rows.length) throw new PlatformError("Record not found", 404);
        const record =
          typeof rows[0].document === "string"
            ? JSON.parse(rows[0].document)
            : rows[0].document;
        await requireAccess(record, args.data);
        if (operation === "get") result = record;
        if (operation === "delete") {
          await connection.execute(
            "DELETE FROM platform_records WHERE app_id=? AND entity=? AND id=?",
            [scope.appId, entity, args.id],
          );
          result = { id: args.id };
        }
        if (operation === "update") {
          clean(args.data);
          result = {
            ...record,
            ...args.data,
            updated_date: new Date().toISOString(),
          };
          definition.validate?.(result);
          await requireAccess(result, args.data);
          await connection.execute(
            "UPDATE platform_records SET document=? WHERE app_id=? AND entity=? AND id=?",
            [JSON.stringify(result), scope.appId, entity, args.id],
          );
        }
      }
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
/** Example policy: owner records only; service access is an explicit server-side capability. */
export const ownerOnly: Policy = ({ user, record }) =>
  !!user && (!record || record.created_by === (user.email ?? user.id));
