import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MySQLStore, ownerOnly } from "../dist/mysql.js";
test(
  "real MySQL: CRUD, isolation, numeric filters, policies, pagination and rollback",
  { skip: !process.env.TEST_MYSQL_URL },
  async () => {
    const store = new MySQLStore(process.env.TEST_MYSQL_URL, {
      Task: {
        authorize: ownerOnly,
        validate: (d) => {
          if (d.title === "invalid") throw Error("invalid");
        },
      },
    });
    const appId = "test-" + randomUUID(),
      alice = { appId, user: { id: "alice" } },
      bob = { appId, user: { id: "bob" } };
    try {
      await store.migrate();
      const a = await store.execute(alice, "Task", "create", {
          data: { title: "a", count: 2 },
        }),
        b = await store.execute(alice, "Task", "create", {
          data: { title: "b", count: 10 },
        });
      await store.execute(bob, "Task", "create", {
        data: { title: "secret", count: 1 },
      });
      assert.deepEqual(
        (
          await store.execute(alice, "Task", "filter", {
            query: { count: { $gte: 2 } },
            sort: "count",
          })
        ).map((r) => r.count),
        [2, 10],
      );
      assert.equal(
        (
          await store.execute(alice, "Task", "filter", {
            query: { $or: [{ title: "a" }, { title: "b" }] },
            sort: "count",
            skip: 1,
            limit: 1,
          })
        )[0].id,
        b.id,
      );
      assert.equal(
        (await store.execute({ ...alice, appId: "other" }, "Task", "filter"))
          .length,
        0,
      );
      await assert.rejects(
        () => store.execute(bob, "Task", "get", { id: a.id }),
        (e) => e.status === 403,
      );
      await assert.rejects(
        () =>
          store.execute(alice, "Task", "create", {
            data: { created_by: "bob" },
          }),
        (e) => e.status === 400,
      );
      await store.execute(alice, "Task", "update", {
        id: a.id,
        data: { title: "changed" },
      });
      assert.equal(
        (await store.execute(alice, "Task", "get", { id: a.id })).title,
        "changed",
      );
      await assert.rejects(() =>
        store.execute(alice, "Task", "bulkCreate", {
          data: [{ title: "rollback" }, { title: "invalid" }],
        }),
      );
      assert.equal(
        (
          await store.execute(alice, "Task", "filter", {
            query: { title: "rollback" },
          })
        ).length,
        0,
      );
      assert.equal(
        (await store.execute({ ...alice, service: true }, "Task", "filter"))
          .length,
        3,
      );
      await store.execute(alice, "Task", "delete", { id: a.id });
      await assert.rejects(
        () => store.execute(alice, "Task", "get", { id: a.id }),
        (e) => e.status === 404,
      );
    } finally {
      await store.pool.execute("DELETE FROM platform_records WHERE app_id=?", [
        appId,
      ]);
      await store.close();
    }
  },
);
