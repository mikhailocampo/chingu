/**
 * LOCAL Sabre types only.
 *
 * `backend/sabre/` is owned by another agent and is NOT imported here yet — this
 * file exists so the shape of a reissue payload is written down without a
 * cross-package dependency. Replace with the real import once that package
 * lands; nothing in this worker calls Sabre.
 *
 * These endpoints deliberately do not touch Sabre at all. A human is on the
 * phone, so confirm_choice writes a PENDING `action` row and returns; a
 * separate executor performs the reshop/reissue.
 */

export interface ReissueRequest {
  /** Sabre PNR locator. */
  pnr: string;
  /** Offer id returned by reshop, quoted before the call. */
  provider_offer_id: string | null;
  /** Staleness guard: compare against the live booking before acting. */
  expected_num_updates: number | null;
  charge_type: "ADD_COLLECT" | "EVEN" | "REFUND" | null;
  total_delta: string | null;
  currency: string | null;
}

export interface ReissueResult {
  ticket_number: string;
  confirmation: string;
}
