export type Data = Record<string, any>;
export type ListOptions = {
  sort?: string | Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  fields?: string[];
};
export function listArgs(
  sort?: string | ListOptions,
  limit?: number,
  skip?: number,
  fields?: string[],
) {
  if (typeof sort === "object" && sort !== null) {
    const options = sort;
    let order = options.sort;
    if (order && typeof order === "object") {
      const entries = Object.entries(order);
      if (entries.length !== 1)
        throw new PlatformError("Only one sort field is supported", 400);
      order = (entries[0][1] === -1 ? "-" : "") + entries[0][0];
    }
    return { query: {}, ...options, sort: order };
  }
  return { query: {}, sort, limit, skip, fields };
}
export interface Entity<T extends Data = Data> {
  list(
    sort?: string | ListOptions,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>;
  filter(
    query: Data,
    sort?: string,
    limit?: number,
    skip?: number,
    fields?: string[],
  ): Promise<T[]>;
  get(id: string): Promise<T>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<{ id: string }>;
  bulkCreate(data: Partial<T>[]): Promise<T[]>;
  subscribe(
    callback: (event: {
      id: string;
      type: "create" | "update" | "delete";
      data?: T;
    }) => void,
    onError?: (error: Error) => void,
  ): () => void;
}
export class PlatformError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = "PLATFORM_ERROR",
  ) {
    super(message);
  }
}
export interface ClientOptions {
  appId: string;
  serverUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  loginUrl?: string;
  requiresAuth?: boolean;
  functionsVersion?: string;
  appBaseUrl?: string;
  onRealtimeError?: (error: Error) => void;
}
/** Browser-safe client. Service credentials only exist in the server entrypoint. */
export function createClient(options: ClientOptions) {
  if (!options.appId) throw new Error("appId is required");
  let token = options.token;
  const transport = options.fetch ?? globalThis.fetch;
  const root = `${(options.serverUrl ?? "").replace(/\/$/, "")}/api/apps/${encodeURIComponent(options.appId)}`;
  function subscribe(
    path: string,
    callback: (value: any) => void,
    onError = options.onRealtimeError,
  ) {
    const abort = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await transport(root + path, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: "same-origin",
          signal: abort.signal,
        });
        if (!response.ok)
          throw new PlatformError("Subscription rejected", response.status);
        if (
          !response.headers
            .get("content-type")
            ?.startsWith("text/event-stream") ||
          !response.body
        )
          throw new Error("Invalid event stream");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 16 * 1024 * 1024)
            throw new Error("Event too large");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = frame
              .split("\n")
              .find((l) => l.startsWith("event:"))
              ?.slice(6)
              .trim();
            const payload = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (event === "error") throw new Error(JSON.parse(payload).error);
            if (event === "snapshot" && !abort.signal.aborted)
              callback(JSON.parse(payload));
          }
        }
      } catch (e) {
        if (!abort.signal.aborted)
          onError?.(e instanceof Error ? e : new Error("Subscription failed"));
        if (
          e instanceof PlatformError &&
          [401, 403, 404, 501].includes(e.status)
        )
          return;
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (!abort.signal.aborted) retry = setTimeout(connect, 1000);
    }
    void connect();
    return () => {
      abort.abort();
      if (retry) clearTimeout(retry);
    };
  }
  async function call(path: string, body: unknown = {}, method = "POST") {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const multipart = body instanceof FormData;
    if (!multipart) headers["Content-Type"] = "application/json";
    const response = await transport(root + path, {
      method,
      headers,
      credentials: "same-origin",
      body:
        method === "GET" ? undefined : multipart ? body : JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok)
      throw new PlatformError(
        value.error ?? "Request failed",
        response.status,
        value.code,
      );
    return value;
  }
  const entities = new Proxy(Object.create(null), {
    get: (_, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      const route = `/entities/${encodeURIComponent(name)}`;
      return {
        list: (
          sort?: string | ListOptions,
          limit?: number,
          skip?: number,
          fields?: string[],
        ) => call(route + "/filter", listArgs(sort, limit, skip, fields)),
        filter: (
          query: Data,
          sort?: string,
          limit?: number,
          skip?: number,
          fields?: string[],
        ) => call(route + "/filter", { query, sort, limit, skip, fields }),
        get: (id: string) => call(route + "/get", { id }),
        create: (data: Data) => call(route + "/create", { data }),
        update: (id: string, data: Data) =>
          call(route + "/update", { id, data }),
        delete: (id: string) => call(route + "/delete", { id }),
        bulkCreate: (data: Data[]) => call(route + "/bulkCreate", { data }),
        subscribe: (
          callback: (event: Data) => void,
          onError?: (error: Error) => void,
        ) => {
          let previous = new Map<string, Data>();
          return subscribe(
            route + "/subscribe",
            (rows: Data[]) => {
              const next = new Map(rows.map((row) => [row.id, row]));
              for (const [id, row] of next) {
                const old = previous.get(id);
                if (!old || JSON.stringify(old) !== JSON.stringify(row))
                  callback({ id, type: old ? "update" : "create", data: row });
              }
              for (const id of previous.keys())
                if (!next.has(id)) callback({ id, type: "delete" });
              previous = next;
            },
            onError,
          );
        },
      };
    },
  }) as Record<string, Entity>;
  const redirect = (url: string) => {
    if (typeof window === "undefined") return url;
    window.location.assign(url);
    return url;
  };
  const login = async (method: string, args: Data) => {
    const result = await call("/auth/" + method, args);
    if (result.access_token) token = result.access_token;
    return result;
  };
  const auth = {
    me: (): Promise<Data> => call("/auth/me"),
    updateMe: (data: Data) => call("/auth/updateMe", data),
    setToken: (value: string) => {
      token = value;
    },
    isAuthenticated: async () => {
      try {
        await call("/auth/me");
        return true;
      } catch (e) {
        if (e instanceof PlatformError && e.status === 401) return false;
        throw e;
      }
    },
    loginViaEmailPassword: (email: string, password: string) =>
      login("loginViaEmailPassword", { email, password }),
    register: (data: Data) => login("register", data),
    verifyOtp: (data: Data) => login("verifyOtp", data),
    resendOtp: (data: Data | string) =>
      call(
        "/auth/resendOtp",
        typeof data === "string" ? { email: data } : data,
      ),
    resetPasswordRequest: (email: string) =>
      call("/auth/resetPasswordRequest", { email }),
    resetPassword: (data: Data) => call("/auth/resetPassword", data),
    logout: async (returnTo?: string) => {
      try {
        await call("/auth/logout");
      } finally {
        token = undefined;
      }
      if (returnTo) redirect(returnTo);
    },
    redirectToLogin: (returnTo?: string) =>
      redirect(
        `${options.loginUrl ?? "/login"}${returnTo ? "?returnTo=" + encodeURIComponent(returnTo) : ""}`,
      ),
    loginWithProvider: (provider: string, returnTo?: string) =>
      redirect(
        `${root}/auth/provider/${encodeURIComponent(provider)}${returnTo ? "?returnTo=" + encodeURIComponent(returnTo) : ""}`,
      ),
  };
  const Core = new Proxy(Object.create(null), {
    get: (_, name) => {
      if (typeof name !== "string" || name === "then") return undefined;
      return (data: Data) => {
        if (data.file instanceof Blob) {
          const form = new FormData();
          for (const [key, value] of Object.entries(data))
            form.append(key, value instanceof Blob ? value : String(value));
          return call("/integrations/Core/" + encodeURIComponent(name), form);
        }
        return call("/integrations/Core/" + encodeURIComponent(name), data);
      };
    },
  }) as Record<string, (data: Data) => Promise<any>>;
  return {
    entities,
    auth,
    agents: {
      createConversation: (data: Data) =>
        call("/agents/createConversation", data),
      listConversations: (data: Data = {}) =>
        call("/agents/listConversations", data),
      getConversation: (id: string) => call("/agents/getConversation", { id }),
      addMessage: (conversation: Data | string, message: Data) =>
        call("/agents/addMessage", {
          id: typeof conversation === "string" ? conversation : conversation.id,
          message,
        }),
      subscribeToConversation: (
        id: string,
        callback: (conversation: Data) => void,
        onError?: (error: Error) => void,
      ) =>
        subscribe(
          "/agents/subscribe/" + encodeURIComponent(id),
          callback,
          onError,
        ),
    },
    workflows: {
      enqueue: (
        name: string,
        input: Data,
        options: {
          idempotencyKey: string;
          delayMs?: number;
          maxAttempts?: number;
        },
      ) => call("/workflows/enqueue", { name, input, options }),
      get: (id: string) => call("/workflows/get", { id }),
    },
    integrations: { Core },
    functions: {
      invoke: async (name: string, data: Data = {}) => ({
        data: await call("/functions/" + encodeURIComponent(name), data),
      }),
    },
    analytics: { track: (data: Data) => call("/analytics/track", data) },
    appLogs: {
      logUserInApp: (pageName: string) =>
        call("/appLogs/logUserInApp", { pageName }),
    },
  };
}
