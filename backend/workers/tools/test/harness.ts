/**
 * Test harness: boots a real local D1 (miniflare/workerd) seeded from the
 * canonical worker/schema.sql + worker/seed.sql, and drives the tools Worker's
 * exported fetch handler in-process.
 *
 * Runner choice: bun test (the required runner) + miniflare. @cloudflare/
 * vitest-pool-workers only runs under vitest, and `bun test` is the stated
 * deliverable. Miniflare gives the genuine workerd D1 implementation over a
 * proxy, so "real local D1" holds.
 *
 * One workerd process is shared across the whole run and the database is reset
 * between tests — spawning a Miniflare per test raced and produced broken-pipe
 * failures once more than one suite was in flight.
 */
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

const SCHEMA = readFileSync(resolve(REPO, "worker/schema.sql"), "utf8");
const SEED = readFileSync(resolve(REPO, "worker/seed.sql"), "utf8");

/** Table names in creation order, so drops can run in reverse. */
const TABLES = [...SCHEMA.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);

export const SLOT_TOKENS = {
  "slot-a": "tok_slot_a_AAAA1111",
  "slot-b": "tok_slot_b_BBBB2222",
  "slot-c": "tok_slot_c_CCCC3333",
};

/**
 * SQL files are split on semicolons at end-of-line. Neither schema.sql nor
 * seed.sql contains a semicolon inside a string literal, so this is safe here;
 * it is not a general-purpose SQL splitter.
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

export type TestCtx = {
  db: D1Database;
  env: Record<string, unknown>;
  dispose: () => Promise<void>;
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

/** Fresh schema + seed for each test. Cheap enough to do per-test. */
export async function boot(): Promise<TestCtx> {
  const d = await instance();
  for (const t of [...TABLES].reverse()) {
    await d.prepare(`DROP TABLE IF EXISTS ${t}`).run();
  }
  await runSql(d, SCHEMA);
  await runSql(d, SEED);

  const env = {
    DB: d,
    SLOT_TOKEN_SLOT_A: SLOT_TOKENS["slot-a"],
    SLOT_TOKEN_SLOT_B: SLOT_TOKENS["slot-b"],
    SLOT_TOKEN_SLOT_C: SLOT_TOKENS["slot-c"],
  };

  return { db: d, env, dispose: async () => {} };
}

/** Tear the shared workerd process down so the run can exit. */
export async function shutdown() {
  if (mf) await mf.dispose();
  mf = null;
  db = null;
}

/** Drive the Worker's exported fetch handler directly. */
export async function call(
  ctx: TestCtx,
  method: "GET" | "POST",
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const worker = (await import("../src/index")).default;
  const headers: Record<string, string> = {};
  if (opts.token !== null) {
    const slot = path.split("/")[2] as keyof typeof SLOT_TOKENS;
    const tok = opts.token ?? SLOT_TOKENS[slot];
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res: Response = await worker.fetch(
    new Request(`https://tools.chingu.example${path}`, { method, headers, body }),
    ctx.env as any,
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}
