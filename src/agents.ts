import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { PlatformError, type Data } from "./client.js";
import type { Scope } from "./mysql.js";
export interface AgentDefinition {
  authorize: (scope: Scope) => boolean | Promise<boolean>;
  respond: (
    messages: Data[],
    context: Scope & { signal: AbortSignal; conversationId: string },
  ) => Promise<{ content: string }>;
}
const decode = (v: any) => (typeof v === "string" ? JSON.parse(v) : v);
export class AgentService {
  constructor(
    readonly pool: Pool,
    readonly definitions: Record<string, AgentDefinition>,
    readonly timeoutMs = 60000,
  ) {}
  async migrate() {
    await this.pool.execute(
      `CREATE TABLE IF NOT EXISTS platform_conversations (id VARCHAR(36) PRIMARY KEY,app_id VARCHAR(100) NOT NULL,owner_id VARCHAR(100) NOT NULL,agent_name VARCHAR(100) NOT NULL,document JSON NOT NULL,lease_token VARCHAR(36) NULL,lease_until BIGINT NULL,KEY owner_conversations(app_id,owner_id))`,
    );
  }
  private async authorize(scope: Scope, name: string) {
    const d = Object.hasOwn(this.definitions, name)
      ? this.definitions[name]
      : undefined;
    if (!scope.user || !d || !(await d.authorize(scope)))
      throw new PlatformError("Forbidden", 403);
    return d;
  }
  async execute(scope: Scope, operation: string, data: Data = {}) {
    if (!scope.user) throw new PlatformError("Unauthorized", 401);
    if (operation === "createConversation") {
      await this.authorize(scope, data.agent_name);
      const doc = {
        id: randomUUID(),
        agent_name: data.agent_name,
        metadata: data.metadata ?? {},
        messages: [],
        status: "idle",
        created_date: new Date().toISOString(),
      };
      await this.pool.execute(
        "INSERT INTO platform_conversations (id,app_id,owner_id,agent_name,document) VALUES (?,?,?,?,?)",
        [
          doc.id,
          scope.appId,
          scope.user.id,
          doc.agent_name,
          JSON.stringify(doc),
        ],
      );
      return doc;
    }
    if (operation === "listConversations") {
      const [rows] = await this.pool.execute<any[]>(
        "SELECT agent_name,document FROM platform_conversations WHERE app_id=? AND owner_id=? ORDER BY id",
        [scope.appId, scope.user.id],
      );
      const docs = [];
      for (const row of rows) {
        if (data.agent_name && data.agent_name !== row.agent_name) continue;
        try {
          await this.authorize(scope, row.agent_name);
          docs.push(decode(row.document));
        } catch (e) {
          if (!(e instanceof PlatformError)) throw e;
        }
      }
      return docs;
    }
    if (!["getConversation", "addMessage"].includes(operation))
      throw new PlatformError("Unknown agent operation", 404);
    if (typeof data.id !== "string")
      throw new PlatformError("Conversation id required", 400);
    const c = await this.pool.getConnection();
    let doc: any,
      definition: AgentDefinition,
      token = randomUUID();
    try {
      await c.beginTransaction();
      const [rows] = await c.execute<any[]>(
        "SELECT * FROM platform_conversations WHERE id=? AND app_id=? AND owner_id=? FOR UPDATE",
        [data.id, scope.appId, scope.user.id],
      );
      if (!rows.length) throw new PlatformError("Conversation not found", 404);
      const row = rows[0];
      definition = await this.authorize(scope, row.agent_name);
      doc = decode(row.document);
      if (operation === "getConversation") {
        await c.commit();
        return doc;
      }
      const message = data.message;
      if (
        !message ||
        message.role !== "user" ||
        typeof message.content !== "string" ||
        message.content.length < 1 ||
        message.content.length > 32000
      )
        throw new PlatformError(
          "A user message of 1-32000 characters is required",
          400,
        );
      if (
        message.file_urls !== undefined &&
        (!Array.isArray(message.file_urls) ||
          message.file_urls.length > 10 ||
          message.file_urls.some(
            (u: unknown) => typeof u !== "string" || !u.startsWith("https://"),
          ))
      )
        throw new PlatformError("Invalid attachments", 400);
      if (row.lease_token && Number(row.lease_until) > Date.now())
        throw new PlatformError("Agent is already responding", 409);
      if (doc.messages.length >= 200)
        throw new PlatformError("Conversation limit reached", 413);
      doc.messages.push({
        id: randomUUID(),
        role: "user",
        content: message.content,
        ...(message.file_urls ? { file_urls: message.file_urls } : {}),
        created_date: new Date().toISOString(),
      });
      doc.status = "running";
      await c.execute(
        "UPDATE platform_conversations SET document=?,lease_token=?,lease_until=? WHERE id=?",
        [
          JSON.stringify(doc),
          token,
          Date.now() + this.timeoutMs + 1000,
          doc.id,
        ],
      );
      await c.commit();
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      c.release();
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        definition!.respond(structuredClone(doc.messages), {
          ...scope,
          signal: abort.signal,
          conversationId: doc.id,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("Agent timed out"));
          }, this.timeoutMs);
        }),
      ]);
      if (
        typeof response?.content !== "string" ||
        response.content.length > 128000
      )
        throw new Error("Invalid agent response");
      doc.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: response.content,
        created_date: new Date().toISOString(),
      });
      doc.status = "idle";
    } catch {
      doc.status = "failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    const [saved] = await this.pool.execute<any>(
      "UPDATE platform_conversations SET document=?,lease_token=NULL,lease_until=NULL WHERE id=? AND app_id=? AND owner_id=? AND lease_token=?",
      [JSON.stringify(doc), doc.id, scope.appId, scope.user.id, token],
    );
    if (!saved.affectedRows)
      throw new PlatformError("Agent response superseded", 409);
    return doc;
  }
}
