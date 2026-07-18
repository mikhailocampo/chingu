export interface Env {
  DB: D1Database;
  // One bearer token per slot: SLOT_TOKEN_SLOT_A, SLOT_TOKEN_SLOT_B, ...
  [key: string]: unknown;
}

/** A slot resolved to its live, non-terminal dispatch. */
export type Bound = {
  slot: string;
  dispatch_id: string;
  kind: "CALL_EMPLOYEE" | "CALL_VENUE" | "CALL_NOTIFY";
  impact_id: string | null;
  employee_id: string | null;
  activity_id: string | null;
};
