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
}
/** Browser-safe client. Service credentials only exist in the server entrypoint. */
export function createClient(options: ClientOptions) {
  if (!options.appId) throw new Error("appId is required");
  let token = options.token;
  const transport = options.fetch ?? globalThis.fetch;
  const root = `${(options.serverUrl ?? "").replace(/\/$/, "")}/api/apps/${encodeURIComponent(options.appId)}`;
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
