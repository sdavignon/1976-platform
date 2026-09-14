import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../dist/client.js";
import { createHandler } from "../dist/server.js";
import { MySQLStore, ownerOnly, compileFilter } from "../dist/mysql.js";
import { R2Storage } from "../dist/cloudflare.js";

const scope = {
  appId: "qa-app",
  user: { id: "alice", email: "alice@example.test" },
};
function poolFixture(records = []) {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push(["begin"]);
    },
    async commit() {
      calls.push(["commit"]);
    },
    async rollback() {
      calls.push(["rollback"]);
    },
    release() {
      calls.push(["release"]);
    },
    async execute(sql, params) {
      calls.push([sql, params]);
      return [
        sql.startsWith("SELECT")
          ? records.map((document) => ({ document }))
          : {},
      ];
    },
  };
  return {
    calls,
    async execute(sql, params) {
      return connection.execute(sql, params);
    },
    async getConnection() {
      return connection;
    },
  };
}

test("QA: denied records do not consume visible pagination and fields do not expose private attributes", async () => {
  const pool = poolFixture([
    { id: "hidden", created_by: "bob@example.test" },
    {
      id: "visible",
      created_by: scope.user.email,
      title: "public",
      secret: "private",
    },
  ]);
  const store = new MySQLStore(pool, { Post: { authorize: ownerOnly } });
  assert.deepEqual(
    await store.execute(scope, "Post", "filter", {
      limit: 1,
      fields: ["title"],
    }),
    [{ id: "visible", title: "public" }],
  );
  assert.deepEqual(pool.calls[0][1], ["qa-app", "Post"]);
});

test("QA: denied update rolls back and never writes or commits", async () => {
  const pool = poolFixture([
    { id: "other", created_by: "bob@example.test", title: "old" },
  ]);
  const store = new MySQLStore(pool, { Post: { authorize: ownerOnly } });
  await assert.rejects(
    store.execute(scope, "Post", "update", {
      id: "other",
      data: { title: "new" },
    }),
    { status: 403 },
  );
  assert.ok(pool.calls.some(([sql]) => sql === "rollback"));
  assert.ok(
    !pool.calls.some(([sql]) => sql.startsWith("UPDATE") || sql === "commit"),
  );
  assert.equal(pool.calls.at(-1)[0], "release");
});

test("QA: bulk validation failure rolls back previously inserted batch rows", async () => {
  const pool = poolFixture();
  const store = new MySQLStore(pool, {
    Post: {
      authorize: ownerOnly,
      validate: (data) => {
        if (!data.title) throw Error("Title required");
      },
    },
  });
  await assert.rejects(
    store.execute(scope, "Post", "bulkCreate", {
      data: [{ title: "valid" }, {}],
    }),
    /Title required/,
  );
  assert.equal(
    pool.calls.filter(([sql]) => sql.startsWith("INSERT")).length,
    1,
  );
  assert.ok(pool.calls.some(([sql]) => sql === "rollback"));
  assert.ok(!pool.calls.some(([sql]) => sql === "commit"));
});

test("QA: SQL filters bind hostile values and reject hostile field names", () => {
  const hostile = "' OR 1=1; --";
  const compiled = compileFilter({
    title: hostile,
    $or: [{ count: { $gte: 3 } }, { enabled: true }],
  });
  assert.ok(!compiled.sql.includes(hostile));
  assert.deepEqual(compiled.params, [JSON.stringify(hostile), "3", "true"]);
  assert.throws(() => compileFilter({ "title') OR 1=1 --": "x" }), {
    status: 400,
  });
  assert.throws(() => compileFilter({ title: { $regex: ".*" } }), {
    status: 400,
  });
});

test("QA: service headers and body cannot bypass function authorization or app boundary", async () => {
  let ran = false;
  const handler = createHandler({
    appId: scope.appId,
    store: { execute: async () => null },
    authenticate: async () => scope.user,
    functions: {
      admin: {
        authorize: () => false,
        run: () => {
          ran = true;
        },
      },
    },
  });
  const request = (app) =>
    new Request(`https://example.test/api/apps/${app}/functions/admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Service-Role": "true" },
      body: JSON.stringify({ service: true, role: "admin" }),
    });
  assert.equal((await handler(request(scope.appId))).status, 403);
  assert.equal((await handler(request("other-app"))).status, 404);
  assert.equal(ran, false);
});

test("QA: private R2 signing policy denies other owners and apps", async () => {
  const storage = new R2Storage({
    accountId: "fixture",
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
    privateBucket: "private",
  });
  const authorize = storage.integrations().CreateFileSignedUrl.authorize;
  assert.equal(await authorize(scope, { file_uri: "qa-app/alice/file" }), true);
  assert.equal(await authorize(scope, { file_uri: "qa-app/bob/file" }), false);
  assert.equal(
    await authorize(scope, { file_uri: "other-app/alice/file" }),
    false,
  );
  assert.equal(
    await authorize(
      { ...scope, user: null },
      { file_uri: "qa-app/alice/file" },
    ),
    false,
  );
  await assert.rejects(storage.signedUrl("qa-app/alice/file", 3601), {
    status: 400,
  });
  storage.client.destroy();
});

test("QA: MailWorthy resendOtp(email) forwards an object accepted by server", async () => {
  let received;
  const handler = createHandler({
    appId: scope.appId,
    store: { execute: async () => null },
    authenticate: async () => null,
    auth: {
      resendOtp: async (data) => {
        received = data;
        return { ok: true };
      },
    },
  });
  const client = createClient({
    appId: scope.appId,
    serverUrl: "https://example.test",
    fetch: (url, init) => handler(new Request(url, init)),
  });
  assert.deepEqual(await client.auth.resendOtp("alice@example.test"), {
    ok: true,
  });
  assert.deepEqual(received, { email: "alice@example.test" });
});
