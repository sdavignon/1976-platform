import { createServer } from "node:http";
import { Readable } from "node:stream";
import { MySQLStore, ownerOnly } from "../dist/mysql.js";
import { createHandler, jwtAuthenticator } from "../dist/server.js";
import { R2Storage } from "../dist/cloudflare.js";

for (const key of [
  "MYSQL_URL",
  "APP_ID",
  "OIDC_JWKS_URL",
  "OIDC_ISSUER",
  "OIDC_AUDIENCE",
])
  if (!process.env[key]) throw new Error(`${key} is required`);
const store = new MySQLStore(process.env.MYSQL_URL, {
  Task: {
    authorize: ownerOnly,
    validate: (data) => {
      if (typeof data.title !== "string" || !data.title.trim())
        throw new Error("Task.title is required");
    },
  },
});
await store.migrate();
const integrations = process.env.R2_ACCOUNT_ID
  ? new R2Storage({
      accountId: process.env.R2_ACCOUNT_ID,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      privateBucket: process.env.R2_PRIVATE_BUCKET,
      publicBucket: process.env.R2_PUBLIC_BUCKET,
      publicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
    }).integrations()
  : {};
const handle = createHandler({
  appId: process.env.APP_ID,
  store,
  authenticate: jwtAuthenticator({
    jwksUrl: process.env.OIDC_JWKS_URL,
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE,
  }),
  integrations,
  functions: {
    hello: {
      authorize: (s) => !!s.user,
      run: (data, c) => ({ message: `Hello ${c.user.id}` }),
    },
  },
  onError: () => console.error("Platform request failed"),
});
const server = createServer(async (req, res) => {
  try {
    const request = new Request(new URL(req.url, "http://localhost"), {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : Readable.toWeb(req),
      duplex: "half",
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    Readable.fromWeb(response.body).pipe(res);
  } catch {
    res.writeHead(500);
    res.end("Internal server error");
  }
});
server.listen(Number(process.env.PORT ?? 1976), "127.0.0.1", () =>
  console.log(
    "1976 Platform listening on loopback; put an HTTPS reverse proxy in front for deployment.",
  ),
);
process.on("SIGTERM", () =>
  server.close(async () => {
    await store.close();
    process.exit(0);
  }),
);
