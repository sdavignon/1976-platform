import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  PlatformError,
  listArgs,
  type ListOptions,
  type Data,
} from "./client.js";
import type { MySQLStore, Scope, Principal } from "./mysql.js";
import type { AgentService } from "./agents.js";
import type { WorkflowEngine } from "./workflows.js";
import { snapshotStream } from "./realtime.js";
export type Handler = (data: Data, context: Context) => any | Promise<any>;
export type RegisteredHandler = {
  authorize: (scope: Scope, data: Data) => boolean | Promise<boolean>;
  run: Handler;
};
export interface Context extends Scope {
  request: Request;
  client: ReturnType<typeof createServerClient>;
}
export interface ServerOptions {
  appId: string;
  store: Pick<MySQLStore, "execute">;
  authenticate: (request: Request) => Promise<Principal | null>;
  functions?: Record<string, RegisteredHandler>;
  integrations?: Record<string, RegisteredHandler>;
  auth?: Record<string, Handler>;
  events?: Record<string, RegisteredHandler>;
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
  agents?: AgentService;
  workflows?: WorkflowEngine;
  realtime?: { intervalMs?: number; maxDurationMs?: number };
}
/** Use an external OIDC issuer. Signature, expiration, issuer and audience are verified. */
export function jwtAuthenticator(options: {
  jwksUrl: string;
  issuer: string;
  audience: string;
}) {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (request: Request): Promise<Principal | null> => {
    const header = request.headers.get("authorization");
    if (!header) return null;
    if (!header.startsWith("Bearer "))
      throw new PlatformError("Unauthorized", 401);
    try {
      const { payload } = await jwtVerify(header.slice(7), jwks, {
        issuer: options.issuer,
        audience: options.audience,
        requiredClaims: ["sub", "exp"],
      });
      return {
        id: payload.sub!,
        email: typeof payload.email === "string" ? payload.email : undefined,
        role: typeof payload.role === "string" ? payload.role : undefined,
      };
    } catch {
      throw new PlatformError("Unauthorized", 401);
    }
  };
}
const own = <T>(
  map: Record<string, T> | undefined,
  key: string,
): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);
async function registered(
  handler: RegisteredHandler | undefined,
  data: Data,
  context: Context,
) {
  if (!handler)
    throw new PlatformError("Feature is not configured", 501, "NOT_CONFIGURED");
  if (!context.service && (await handler.authorize(context, data)) !== true)
    throw new PlatformError("Forbidden", 403);
  return handler.run(data, context);
}
/** Trusted backend factory. Never export this entrypoint into a browser bundle. */
export function createServerClient(
  options: ServerOptions,
  request: Request,
  scope: Scope,
) {
  function make(active: Scope): any {
    const context = (): Context => ({
      ...active,
      request,
      client: make(active),
    });
    const entities = new Proxy(Object.create(null), {
      get: (_, entity) => {
        if (typeof entity !== "string" || entity === "then") return undefined;
        const run = (op: string, args: Data = {}) =>
          options.store.execute(active, entity, op, args);
        return {
          list: (
            sort?: string | ListOptions,
            limit?: number,
            skip?: number,
            fields?: string[],
          ) => run("filter", listArgs(sort, limit, skip, fields)),
          filter: (
            query: Data,
            sort?: string,
            limit?: number,
            skip?: number,
            fields?: string[],
          ) => run("filter", { query, sort, limit, skip, fields }),
          get: (id: string) => run("get", { id }),
          create: (data: Data) => run("create", { data }),
          update: (id: string, data: Data) => run("update", { id, data }),
          delete: (id: string) => run("delete", { id }),
          bulkCreate: (data: Data[]) => run("bulkCreate", { data }),
        };
      },
    });
    return {
      entities,
      agents: {
        createConversation: (data: Data) =>
          options.agents?.execute(active, "createConversation", data) ??
          Promise.reject(new PlatformError("Agents not configured", 501)),
        listConversations: (data: Data = {}) =>
          options.agents?.execute(active, "listConversations", data) ??
          Promise.reject(new PlatformError("Agents not configured", 501)),
        getConversation: (id: string) =>
          options.agents?.execute(active, "getConversation", { id }) ??
          Promise.reject(new PlatformError("Agents not configured", 501)),
        addMessage: (conversation: Data | string, message: Data) =>
          options.agents?.execute(active, "addMessage", {
            id:
              typeof conversation === "string" ? conversation : conversation.id,
            message,
          }) ?? Promise.reject(new PlatformError("Agents not configured", 501)),
      },
      auth: {
        me: async () => {
          if (!active.user) throw new PlatformError("Unauthorized", 401);
          return active.user;
        },
      },
      functions: {
        invoke: async (name: string, data: Data = {}) => ({
          data: await registered(own(options.functions, name), data, context()),
        }),
      },
      integrations: {
        Core: new Proxy(Object.create(null), {
          get: (_, name) =>
            typeof name === "string" && name !== "then"
              ? (data: Data) =>
                  registered(own(options.integrations, name), data, context())
              : undefined,
        }),
      },
      get asServiceRole() {
        return make({ ...active, service: true });
      },
    };
  }
  return make(scope);
}
/** Explicit options replace Base44's implicit runtime environment. */
export async function createClientFromRequest(
  request: Request,
  options: ServerOptions,
) {
  return createServerClient(options, request, {
    appId: options.appId,
    user: await options.authenticate(request),
  });
}
async function body(request: Request, max: number): Promise<Data> {
  if (!request.body) return {};
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new PlatformError("Request too large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    if (
      request.headers.get("content-type")?.startsWith("multipart/form-data")
    ) {
      const form = await new Response(bytes, {
        headers: { "content-type": request.headers.get("content-type")! },
      }).formData();
      return Object.fromEntries(form);
    }
    const value = JSON.parse(new TextDecoder().decode(bytes) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new PlatformError("Invalid request body", 400);
  }
}
export function createHandler(options: ServerOptions) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        prefix = `/api/apps/${encodeURIComponent(options.appId)}/`;
      if (!url.pathname.startsWith(prefix))
        throw new PlatformError("Not found", 404);
      const path = url.pathname
        .slice(prefix.length)
        .split("/")
        .map(decodeURIComponent);
      const provider =
        path[0] === "auth" && path[1] === "provider" && path.length === 3;
      const entityStream =
        path[0] === "entities" && path[2] === "subscribe" && path.length === 3;
      const agentStream =
        path[0] === "agents" && path[1] === "subscribe" && path.length === 3;
      if (
        request.method !== "POST" &&
        !((provider || entityStream || agentStream) && request.method === "GET")
      )
        throw new PlatformError("Method not allowed", 405);
      const scope: Scope = {
        appId: options.appId,
        user: await options.authenticate(request),
      };
      if (entityStream || agentStream) {
        if (!options.realtime)
          throw new PlatformError("Realtime not configured", 501);
        if (!scope.user) throw new PlatformError("Unauthorized", 401);
        return await snapshotStream(
          request,
          async () => {
            const user = await options.authenticate(request);
            if (!user || user.id !== scope.user!.id)
              throw new PlatformError("Unauthorized", 401);
            const fresh = { appId: options.appId, user };
            if (agentStream) {
              if (!options.agents)
                throw new PlatformError("Agents not configured", 501);
              return options.agents.execute(fresh, "getConversation", {
                id: path[2],
              });
            }
            const rows = await options.store.execute(fresh, path[1], "filter", {
              query: {},
              limit: 1000,
            });
            if (rows.length >= 1000)
              throw new PlatformError(
                "Entity subscription exceeds snapshot limit",
                413,
              );
            return rows;
          },
          options.realtime,
        );
      }
      // A user-supplied role or service header never grants service access.
      const context: Context = {
        ...scope,
        request,
        client: createServerClient(options, request, scope),
      };
      const data =
        request.method === "GET"
          ? Object.fromEntries(url.searchParams)
          : await body(request, options.maxBodyBytes ?? 10 * 1024 * 1024);
      let result: any;
      if (path[0] === "agents" && path.length === 2) {
        if (!options.agents)
          throw new PlatformError("Agents not configured", 501);
        result = await options.agents.execute(scope, path[1], data);
      } else if (path[0] === "workflows" && path.length === 2) {
        if (!options.workflows)
          throw new PlatformError("Workflows not configured", 501);
        if (path[1] === "enqueue")
          result = await options.workflows.enqueue(
            scope,
            data.name,
            data.input,
            data.options ?? {},
          );
        else if (path[1] === "get")
          result = await options.workflows.get(scope, data.id);
        else throw new PlatformError("Unknown workflow operation", 404);
      } else if (path[0] === "entities" && path.length === 3)
        result = await options.store.execute(scope, path[1], path[2], data);
      else if (path[0] === "functions" && path.length === 2)
        result = await registered(
          own(options.functions, path[1]),
          data,
          context,
        );
      else if (
        path[0] === "integrations" &&
        path[1] === "Core" &&
        path.length === 3
      )
        result = await registered(
          own(options.integrations, path[2]),
          data,
          context,
        );
      else if (path[0] === "auth" && (path.length === 2 || provider)) {
        if (path[1] === "me") {
          if (!scope.user) throw new PlatformError("Unauthorized", 401);
          result = options.auth?.me
            ? await options.auth.me(data, context)
            : scope.user;
        } else {
          const handler = own(
            options.auth,
            provider ? "provider/" + path[2] : path[1],
          );
          if (!handler)
            throw new PlatformError(
              "Auth provider operation is not configured",
              501,
              "NOT_CONFIGURED",
            );
          result = await handler(data, context);
        }
      } else if (
        ["analytics", "appLogs"].includes(path[0]) &&
        path.length === 2
      )
        result = await registered(
          own(options.events, path.join("/")),
          data,
          context,
        );
      else throw new PlatformError("Not found", 404);
      if (result instanceof Response) return result;
      return Response.json(result ?? null, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (!(error instanceof PlatformError)) options.onError?.(error);
      return Response.json(
        {
          error:
            error instanceof PlatformError
              ? error.message
              : "Internal server error",
          code: error instanceof PlatformError ? error.code : "INTERNAL_ERROR",
        },
        {
          status: error instanceof PlatformError ? error.status : 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
