/**
 * Generates the itinerary fixture by EXECUTING the real schema and seed.
 *
 *   bun run gen:fixtures
 *
 * The alternative was hand-copying nine flights and twenty-five hotel rows out
 * of worker/seed.sql into a TypeScript file. That duplicate goes stale the
 * first time anyone edits the seed, and it goes stale silently — the demo keeps
 * rendering, just with times nobody has flown since. Parsing the SQL with a
 * regex has the same failure mode one layer down.
 *
 * So this loads schema.sql and seed.sql into an in-memory SQLite (D1 is SQLite)
 * and runs worker/src/employee-detail.ts against it — the exact queries the
 * worker serves. Drift stops being a thing you have to remember about: if the
 * seed changes, rerunning this changes the fixture, and if the SQL breaks, this
 * breaks loudly at build time instead of quietly at demo time.
 *
 * The output is checked in so `bun run dev` needs no generation step.
 */
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { loadEmployeeItinerary, type Querier } from "../../worker/src/employee-detail"

const ROOT = resolve(import.meta.dir, "../..")
const EVENT_ID = "evt-busan"
const TARGET = resolve(ROOT, "Frontend/src/lib/generated/itineraries.json")

const db = new Database(":memory:")
db.exec(readFileSync(resolve(ROOT, "worker/schema.sql"), "utf8"))
db.exec(readFileSync(resolve(ROOT, "worker/seed.sql"), "utf8"))

const query: Querier = async (sql, params) =>
  db.query(sql).all(...(params as never[])) as Record<string, unknown>[]

const employees = db.query("SELECT id FROM employee ORDER BY id").all() as { id: string }[]

const out: Record<string, unknown> = {}
for (const { id } of employees) {
  out[id] = await loadEmployeeItinerary(query, id, EVENT_ID)
}

mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, `${JSON.stringify(out, null, 2)}\n`)

// Printed rather than asserted: the counts are the seed's business, not this
// script's, and a hard expectation here would just be a second place to update.
const flights = Object.values(out).flatMap((d) =>
  (d as { itineraries: { segments: { type: string }[] }[] }).itineraries.flatMap((i) =>
    i.segments.filter((s) => s.type === "FLIGHT")
  )
).length
const hotels = Object.values(out).flatMap((d) =>
  (d as { itineraries: { segments: { type: string }[] }[] }).itineraries.flatMap((i) =>
    i.segments.filter((s) => s.type === "HOTEL")
  )
).length

console.log(
  `${employees.length} travellers -> ${TARGET.replace(`${ROOT}/`, "")}\n` +
    `  ${flights} flight segments, ${hotels} hotel segments`
)
