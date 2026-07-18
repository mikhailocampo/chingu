/**
 * D1 test harness for the dispatch worker.
 *
 * Deliberately mirrors backend/workers/tools/test/harness.ts rather than
 * inventing a second pattern: same runner (bun test + miniflare), same
 * shared-workerd-process-with-per-test-reset shape. That harness notes that
 * spawning a Miniflare per test raced and produced broken-pipe failures, so
 * this one does not either.
 *
 * We boot only D1 here. The DO and Queue bindings aren't needed to exercise
 * the read/write endpoints, and leaving them out keeps the suite fast.
 */
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, "..");

const SCHEMA = readFileSync(resolve(WORKER, "schema.sql"), "utf8");
const SEED = readFileSync(resolve(WORKER, "seed.sql"), "utf8");

/** Table names in creation order, so drops can run in reverse. */
const TABLES = [...SCHEMA.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);

/**
 * Split on semicolons at end-of-line. Neither schema.sql nor seed.sql contains
 * a semicolon inside a string literal, so this holds here. Not a general SQL
 * splitter.
 */
function statements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

async function runSql(db: D1Database, sql: string) {
  for (const s of statements(sql)) await db.prepare(s).run();
}

export type TestEnv = {
  DB: D1Database;
  DIAL_ALLOWLIST?: string;
};

let mf: Miniflare | null = null;
let db: D1Database | null = null;

async function instance(): Promise<D1Database> {
  if (db) return db;
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch: () => new Response('ok') }",
    d1Databases: { DB: ":memory:" },
    d1Persist: false,
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  return db;
}

/** Fresh schema + seed per test. */
export async function boot(): Promise<TestEnv> {
  const d = await instance();
  for (const t of [...TABLES].reverse()) {
    await d.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  }
  await runSql(d, SCHEMA);
  await runSql(d, SEED);
  return { DB: d };
}

/** Tear the shared workerd process down so the run can exit. */
export async function shutdown() {
  if (mf) await mf.dispose();
  mf = null;
  db = null;
}

/** Convenience: one-column scalar. */
export async function scalar<T = unknown>(
  env: TestEnv,
  sql: string,
  ...binds: unknown[]
): Promise<T> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<Record<string, T>>();
  return row ? (Object.values(row)[0] as T) : (null as T);
}
