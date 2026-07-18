import { beforeEach, describe, expect, test } from "bun:test";
import { boot, scalar, type TestEnv } from "./harness";
import { drainActions } from "../src/actions";
import { disrupt, impactIdFor } from "../src/dev-disrupt";
import { decideApproval } from "../src/transitions";

let env: TestEnv;
const NOW = new Date("2026-09-13T18:00:00Z");
const IMPACT = impactIdFor("emp-us-04");

beforeEach(async () => {
  env = await boot();
  await disrupt(env as any, NOW);
});

/** Park and approve, which is what leaves an EXECUTING impact + PENDING action. */
async function approveElena(offerRank = 2) {
  const offerId = `ofr-${IMPACT}-${offerRank}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE disruption_impact SET state='AWAITING_APPROVAL', selected_offer_id=? WHERE id=?`,
    ).bind(offerId, IMPACT),
    env.DB.prepare(
      `INSERT INTO approval (id, impact_id, offer_id, reason, requested_at)
       VALUES ('apr-1', ?, ?, 'OVER_THRESHOLD', ?)`,
    ).bind(IMPACT, offerId, NOW.toISOString()),
  ]);
  await decideApproval(
    env as any,
    { approvalId: "apr-1", decision: "APPROVED", decidedBy: "op-coord" },
    NOW,
  );
}

describe("the terminal write", () => {
  test("an approved impact reaches RESOLVED", async () => {
    await approveElena();
    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "EXECUTING",
    );

    await drainActions(env as any, NOW);

    // Without this the card reads "Booking" forever and the demo has no ending.
    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "RESOLVED",
    );
    expect(
      await scalar<string>(env, `SELECT resolved_at FROM disruption_impact WHERE id='${IMPACT}'`),
    ).toBe(NOW.toISOString());
  });

  test("the action is COMPLETED and marked simulated, with no invented ticket", async () => {
    await approveElena();
    await drainActions(env as any, NOW);

    const row = await env.DB.prepare(
      `SELECT state, completed_at, external_ref, result_json FROM action LIMIT 1`,
    ).first<{ state: string; completed_at: string; external_ref: string | null; result_json: string }>();

    expect(row!.state).toBe("COMPLETED");
    expect(row!.completed_at).toBe(NOW.toISOString());
    // v1 does not call Sabre. It must never look like it did.
    expect(JSON.parse(row!.result_json).simulated).toBe(true);
    expect(row!.external_ref).toBeNull();
  });

  test("the dispatch closes out with a readable summary", async () => {
    await env.DB.prepare(
      `INSERT INTO dispatch (id,kind,impact_id,employee_id,idempotency_key,status,created_at)
       VALUES ('dsp-1','CALL_EMPLOYEE',?, 'emp-us-04','k1','IN_CALL',?)`,
    )
      .bind(IMPACT, NOW.toISOString())
      .run();
    await approveElena();
    await drainActions(env as any, NOW);

    const d = await env.DB.prepare(
      `SELECT status, outcome_summary FROM dispatch WHERE id='dsp-1'`,
    ).first<{ status: string; outcome_summary: string }>();
    expect(d!.status).toBe("RESOLVED");
    expect(d!.outcome_summary).toContain("Rebooked to");
    expect(d!.outcome_summary).toContain("$200.00");
  });

  test("the slot is freed so the pool does not leak", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispatch (id,kind,impact_id,employee_id,slot,idempotency_key,status,created_at)
         VALUES ('dsp-1','CALL_EMPLOYEE',?, 'emp-us-04','slot-a','k1','IN_CALL',?)`,
      ).bind(IMPACT, NOW.toISOString()),
      env.DB.prepare(
        `UPDATE agent_slot SET status='BOUND', dispatch_id='dsp-1', bound_at=?, lease_expires_at=?
          WHERE slot='slot-a'`,
      ).bind(NOW.toISOString(), "2026-12-31T00:00:00Z"),
    ]);
    await approveElena();
    await drainActions(env as any, NOW);

    const slot = await env.DB.prepare(
      `SELECT status, dispatch_id FROM agent_slot WHERE slot='slot-a'`,
    ).first<{ status: string; dispatch_id: string | null }>();
    expect(slot!.status).toBe("FREE");
    expect(slot!.dispatch_id).toBeNull();
  });
});

describe("idempotency and blast radius", () => {
  test("draining twice does not double-complete or re-resolve", async () => {
    await approveElena();
    const first = (await (await drainActions(env as any, NOW)).json()) as any;
    const second = (await (await drainActions(env as any, NOW)).json()) as any;

    expect(first.completed).toBe(1);
    expect(second.completed).toBe(0);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action WHERE state='COMPLETED'`)).toBe(1);
  });

  test("an empty drain is a no-op, not an error", async () => {
    const res = await drainActions(env as any, NOW);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).completed).toBe(0);
  });

  test("a REJECTED impact is not dragged forward to RESOLVED", async () => {
    // Rejection returns the impact to TRIAGING — there may be other options
    // worth offering. A drain must not overrule that.
    await approveElena();
    await env.DB.prepare(`UPDATE disruption_impact SET state='TRIAGING' WHERE id=?`)
      .bind(IMPACT)
      .run();

    await drainActions(env as any, NOW);

    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "TRIAGING",
    );
  });

  test("other travellers are untouched", async () => {
    await approveElena();
    await drainActions(env as any, NOW);

    for (const emp of ["emp-us-01", "emp-us-02", "emp-us-03"]) {
      const state = await scalar<string>(
        env,
        `SELECT state FROM disruption_impact WHERE employee_id='${emp}'`,
      );
      expect(state, `${emp} must not be resolved by someone else's drain`).toBe("TRIAGING");
    }
  });

  test("a malformed result_json does not stop the drain", async () => {
    await approveElena();
    await env.DB.prepare(`UPDATE action SET result_json='{not json'`).run();

    const res = (await (await drainActions(env as any, NOW)).json()) as any;
    expect(res.completed).toBe(1);
    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "RESOLVED",
    );
  });
});
