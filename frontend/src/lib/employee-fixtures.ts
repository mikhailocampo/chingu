/**
 * The offline half of the detail screen.
 *
 * `generated/itineraries.json` is produced by executing worker/schema.sql and
 * worker/seed.sql through the worker's own queries — see
 * Frontend/scripts/gen-itinerary-fixtures.ts. Nothing here is hand-maintained,
 * so the fixture cannot drift from the seed without someone deliberately
 * skipping the generator.
 *
 * The roster card still comes from fixtures.ts rather than the JSON, because
 * status and advisory are scenario-dependent (calm vs disrupted) while the
 * itinerary is not: a cancelled flight does not remove the segment, it adds an
 * impact beside it. Composing the two here keeps the detail screen and the
 * roster incapable of disagreeing about who someone is.
 */
import { fixtureFor, type FixtureScenario } from "./fixtures"
import generated from "./generated/itineraries.json"
import type { EmployeeDetail, ItineraryRecord } from "./employee-types"

type Generated = Record<string, Omit<EmployeeDetail, "card">>

const EMPTY: Omit<EmployeeDetail, "card"> = {
  itineraries: [],
  activities: [],
  offers: [],
}

/**
 * The detail payload for one traveller, or null if they are not on the roster.
 *
 * Scenario is a parameter rather than module state so a caller and the roster
 * poll cannot end up rendering two different worlds in the same frame.
 */
export function employeeDetailFixture(
  employeeId: string,
  scenario: FixtureScenario
): EmployeeDetail | null {
  const card = fixtureFor(scenario).cards.find((c) => c.employeeId === employeeId)
  if (!card) return null

  // The seed carries no disruption, so the generated offers array is always
  // empty. Offers appear only once /api/dev/disrupt has run against a live
  // worker — this file does not invent priced options, because a fabricated
  // add-collect sitting next to an Approve button is the one fixture that could
  // teach someone the wrong number.
  const detail = (generated as Generated)[employeeId] ?? EMPTY

  return {
    card,
    itineraries: detail.itineraries as ItineraryRecord[],
    activities: detail.activities,
    offers: detail.offers,
  }
}
