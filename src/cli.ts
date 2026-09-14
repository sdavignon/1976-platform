#!/usr/bin/env node
import { readFile, readdir, writeFile, open } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { parse, type ParseError } from "jsonc-parser";
import {
  planMigration,
  applyMigration,
  verifyMigration,
  exportData,
} from "./migration.js";

const [command, ...args] = process.argv.slice(2),
  flags: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error("Use --option value");
  flags[args[i].slice(2)] = args[i + 1];
}
const required = (key: string) => {
  if (!flags[key]) throw new Error(`--${key} required`);
  return flags[key];
};
async function schemas(dir: string) {
  const result: Record<string, any> = {};
  for (const filename of (await readdir(dir)).sort()) {
    if (!/\.jsonc?$/.test(filename)) continue;
    const errors: ParseError[] = [];
    const value = parse(
      await readFile(resolve(dir, filename), "utf8"),
      errors,
      { allowTrailingComma: true },
    );
    if (errors.length) throw new Error(`Invalid JSONC: ${filename}`);
    const name = filename.replace(/\.jsonc?$/, "");
    if (value.name && value.name !== name)
      throw new Error(`Schema name differs from filename: ${filename}`);
    result[name] = value;
  }
  return result;
}
async function main() {
  if (command === "schemas") {
    const values = await schemas(required("directory"));
    const result = {
      schemas: values,
      policiesRequired: Object.keys(values),
      notice: "RLS retained for review, not automatically translated",
    };
    await writeFile(required("output"), JSON.stringify(result, null, 2), {
      flag: "wx",
    });
    return;
  }
  if (!["plan", "import", "verify", "export"].includes(command))
    throw new Error(
      "Commands: schemas --directory DIR --output FILE; plan|verify --bundle FILE --app ID; import --bundle FILE --app ID --digest HASH --receipt FILE; export --directory SCHEMAS --app ID --output FILE. Database commands require MYSQL_URL and an initialized platform_records table.",
    );
  if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL required");
  const pool = mysql.createPool(process.env.MYSQL_URL);
  try {
    if (command === "export") {
      const bundle = await exportData(
        pool,
        required("app"),
        await schemas(required("directory")),
      );
      await writeFile(required("output"), JSON.stringify(bundle, null, 2), {
        flag: "wx",
      });
      return;
    }
    const bundle = JSON.parse(await readFile(required("bundle"), "utf8"));
    if (command === "plan")
      console.log(
        JSON.stringify(
          await planMigration(pool, required("app"), bundle),
          null,
          2,
        ),
      );
    if (command === "verify") {
      const report = await verifyMigration(pool, required("app"), bundle);
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    }
    if (command === "import") {
      const app = required("app"),
        digest = required("digest"),
        file = await open(required("receipt"), "wx");
      try {
        const receipt = await applyMigration(pool, app, bundle, digest);
        console.log(JSON.stringify(receipt));
        await file.writeFile(JSON.stringify(receipt, null, 2));
      } finally {
        await file.close();
      }
    }
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
