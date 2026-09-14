import test from "node:test";
import assert from "node:assert/strict";
import { createClient, PlatformError } from "../dist/client.js";
import { createHandler, createClientFromRequest } from "../dist/server.js";
import { compileFilter } from "../dist/mysql.js";
import { CloudflareDNS, R2Storage } from "../dist/cloudflare.js";
test("client and real handler preserve function envelope and user identity", async () => {
  const options = {
    appId: "demo",
    store: { execute: async () => [] },
    authenticate: async (r) =>
      r.headers.get("Authorization") === "Bearer valid"
        ? { id: "alice" }
        : null,
    functions: {
      echo: {
        authorize: (s) => !!s.user,
        run: (d, c) => ({ ...d, user: c.user.id }),
      },
    },
  };
  const handle = createHandler(options);
  const client = createClient({
    appId: "demo",
    serverUrl: "https://platform.test",
    token: "valid",
    fetch: (url, init) => handle(new Request(url, init)),
  });
  assert.deepEqual(await client.auth.me(), { id: "alice" });
  assert.deepEqual(await client.functions.invoke("echo", { hello: "world" }), {
    data: { hello: "world", user: "alice" },
  });
  client.auth.setToken("invalid");
  assert.equal(await client.auth.isAuthenticated(), false);
  await assert.rejects(
    () => client.functions.invoke("echo"),
    (e) => e.status === 403,
  );
  assert.equal(client.asServiceRole, undefined);
});
test("service role only originates in trusted server factory", async () => {
  const scopes = [];
  const options = {
    appId: "demo",
    authenticate: async () => null,
    store: {
      execute: async (s) => {
        scopes.push(s);
        return [];
      },
    },
  };
  const handle = createHandler(options);
  const response = await handle(
    new Request("https://p/api/apps/demo/entities/Task/filter", {
      method: "POST",
      headers: { "x-service-role": "true" },
      body: JSON.stringify({ service: true, query: {} }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(scopes[0].service, undefined);
  const backend = await createClientFromRequest(
    new Request("https://p"),
    options,
  );
  await backend.asServiceRole.entities.Task.list();
  assert.equal(scopes[1].service, true);
});
test("malformed, oversized, unconfigured and internal errors have explicit safe responses", async () => {
  const options = {
    appId: "a",
    authenticate: async () => null,
    store: {
      execute: async () => {
        throw new Error("secret password");
      },
    },
    maxBodyBytes: 10,
  };
  const handle = createHandler(options);
  for (const [path, body, status] of [
    ["entities/X/get", "{}", 500],
    ["functions/missing", "{}", 501],
    ["auth/register", "{}", 501],
    ["auth/me", "{}", 401],
    ["entities/X/filter", "x".repeat(11), 413],
    ["entities/X/filter", "{", 400],
  ]) {
    const r = await handle(
      new Request("https://p/api/apps/a/" + path, { method: "POST", body }),
    );
    assert.equal(r.status, status);
    assert.ok(!(await r.text()).includes("secret password"));
  }
});
test("SQL operators bind values and reject injected identifiers", () => {
  const value = "x' OR 1=1 --";
  const result = compileFilter({
    $or: [{ status: value }, { count: { $gte: 2 } }],
  });
  assert.ok(!result.sql.includes(value));
  assert.equal(result.params[0], JSON.stringify(value));
  assert.throws(() => compileFilter({ "id) OR TRUE --": 1 }), PlatformError);
  assert.throws(() => compileFilter({ id: { $unknown: 1 } }), PlatformError);
  assert.equal(compileFilter({ id: { $in: [] } }).sql, "FALSE");
});
test("R2 separates private buckets and returns scoped private/public upload shapes", async () => {
  assert.throws(
    () => new R2Storage({ privateBucket: "same", publicBucket: "same" }),
  );
  const r2 = new R2Storage({
    accountId: "test",
    accessKeyId: "test",
    secretAccessKey: "test",
    privateBucket: "private",
    publicBucket: "public",
    publicBaseUrl: "https://media.example.com",
  });
  const commands = [];
  r2.client.send = async (command) => {
    commands.push(command.input);
    return {};
  };
  const privateFile = await r2.upload(new Blob(["private"]), {
    appId: "a",
    userId: "u",
  });
  assert.ok(privateFile.file_uri.startsWith("a/u/"));
  assert.equal(commands[0].Bucket, "private");
  const publicFile = await r2.upload(
    new Blob(["public"]),
    { appId: "a", userId: "u" },
    true,
  );
  assert.ok(publicFile.file_url.startsWith("https://media.example.com/a/u/"));
  assert.equal(commands[1].Bucket, "public");
  const sign = r2.integrations().CreateFileSignedUrl;
  assert.equal(
    await sign.authorize(
      { appId: "a", user: { id: "other" } },
      { file_uri: privateFile.file_uri },
    ),
    false,
  );
  await assert.rejects(
    () => r2.signedUrl(privateFile.file_uri, 999999),
    (e) => e.status === 400,
  );
  const signed = await r2.signedUrl(privateFile.file_uri);
  assert.ok(signed.signed_url.includes("X-Amz-Signature="));
});
test("DNS uses explicit zone and preserves pagination metadata", async () => {
  let seen;
  const dns = new CloudflareDNS("test", "a".repeat(32), async (url, init) => {
    seen = { url, init };
    return Response.json({
      success: true,
      result: [],
      result_info: { page: 1, total_pages: 2 },
    });
  });
  const result = await dns.list({ name: "example.com" });
  assert.equal(result.result_info.total_pages, 2);
  assert.ok(
    seen.url.includes(
      "/zones/" + "a".repeat(32) + "/dns_records?name=example.com",
    ),
  );
  assert.equal(seen.init.method, "GET");
});
