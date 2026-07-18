import { beforeEach, describe, expect, test } from "bun:test";
import { boot, scalar, type TestEnv } from "./harness";
import { decideApproval, TransitionError } from "../src/transitions";
import { disrupt, impactIdFor } from "../src/dev-disrupt";

let env: TestEnv;
const NOW = new Date("2026-09-13T18:00:00Z");
const OP = "op-coord";

const IMPACT = impactIdFor("emp-us-04");
const OFFER_PASS = `ofr-${IMPACT}-1`; // $120
const OFFER_200 = `ofr-${IMPACT}-2`; // $200, NEEDS_APPROVAL
const OFFER_299 = `ofr-${IMPACT}-3`; // $299, NEEDS_APPROVAL

/** Park Elena at AWAITING_APPROVAL against the $200 option, as the phone would. */
async function park(offerId = OFFER_200) {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE disruption_impact SET state='AWAITING_APPROVAL', selected_offer_id=? WHERE id=?`,
    ).bind(offerId, IMPACT),
    env.DB.prepare(
      `INSERT INTO approval (id, impact_id, offer_id, reason, requested_at)
       VALUES ('apr-1', ?, ?, 'OVER_THRESHOLD', ?)`,
    ).bind(IMPACT, offerId, NOW.toISOString()),
  ]);
}

beforeEach(async () => {
  env = await boot();
  await disrupt(env as any, NOW);
});

const decide = (over: Partial<Parameters<typeof decideApproval>[1]> = {}) =>
  decideApproval(env as any, { approvalId: "apr-1", decision: "APPROVED", decidedBy: OP, ...over }, NOW);

describe("closing the gate — the half nothing else could do", () => {
  test("APPROVED writes decided_at, decided_by and decision", async () => {
    await park();
    await decide();

    const row = await env.DB.prepare(
      `SELECT decided_at, decided_by, decision, decided_offer_id FROM approval WHERE id='apr-1'`,
    ).first<any>();

    expect(row.decided_at).toBe(NOW.toISOString());
    expect(row.decided_by).toBe(OP);
    expect(row.decision).toBe("APPROVED");
    // Only set when the human overrode.
    expect(row.decided_offer_id).toBeNull();
  });

  test("the impact moves to EXECUTING", async () => {
    await park();
    await decide();
    // The state commit 7dd6ba5 added for exactly this moment: chosen, action
    // pending, not yet reissued.
    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "EXECUTING",
    );
    expect(
      await scalar<string>(env, `SELECT previous_state FROM disruption_impact WHERE id='${IMPACT}'`),
    ).toBe("AWAITING_APPROVAL");
  });

  test("a PENDING action is queued, attributed to the coordinator", async () => {
    await park();
    const res = await decide();

    const act = await env.DB.prepare(`SELECT * FROM action WHERE id = ?`)
      .bind(res.actionId)
      .first<any>();

    expect(act.kind).toBe("REISSUE");
    expect(act.state).toBe("PENDING");
    // Not AGENT: a human authorised this, and the audit trail must say so.
    expect(act.actor_kind).toBe("COORDINATOR");
    expect(act.actor_id).toBe(OP);
    expect(act.approval_id).toBe("apr-1");
  });

  test("the action records the policy verdict it was judged against", async () => {
    await park();
    const res = await decide();
    const act = await env.DB.prepare(`SELECT result_json FROM action WHERE id=?`)
      .bind(res.actionId)
      .first<{ result_json: string }>();

    // Without this, "the agent followed policy" is unfalsifiable.
    const parsed = JSON.parse(act.result_json);
    expect(parsed.policy_verdict).toBe("NEEDS_APPROVAL");
    expect(parsed.authorised_by).toBe(OP);
    expect(parsed.total_delta).toBe("200.00");
  });
});

describe("MODIFIED — where a human overruled the agent", () => {
  // DATA_MODEL.md:154 calls this the most interesting row in the table.
  test("picking a different offer records MODIFIED and the override", async () => {
    await park(OFFER_200);
    const res = await decide({ decision: "APPROVED", offerId: OFFER_299 });

    expect(res.decision).toBe("MODIFIED");
    const row = await env.DB.prepare(
      `SELECT decision, decided_offer_id FROM approval WHERE id='apr-1'`,
    ).first<any>();
    expect(row.decision).toBe("MODIFIED");
    expect(row.decided_offer_id).toBe(OFFER_299);

    // And the impact follows the human's pick, not the agent's.
    expect(
      await scalar<string>(env, `SELECT selected_offer_id FROM disruption_impact WHERE id='${IMPACT}'`),
    ).toBe(OFFER_299);
  });

  test("passing the SAME offer explicitly stays APPROVED, not MODIFIED", async () => {
    await park(OFFER_200);
    const res = await decide({ offerId: OFFER_200 });
    expect(res.decision).toBe("APPROVED");
  });
});

describe("CRITICAL: a double-click cannot double-ticket", () => {
  test("deciding twice refuses the second attempt", async () => {
    await park();
    await decide();
    await expect(decide()).rejects.toThrow(/already been decided/);
  });

  test("only one action row exists after a repeated attempt", async () => {
    await park();
    await decide();
    await decide().catch(() => {});
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action`)).toBe(1);
  });

  test("the idempotency key is stable, so a collision is a no-op not an error", async () => {
    await park();
    const res = await decide();
    const key = await scalar<string>(
      env,
      `SELECT idempotency_key FROM action WHERE id='${res.actionId}'`,
    );
    // Same shape as confirm-choice.ts:213-217 — the UNIQUE index is the guard.
    expect(key).toBe(`approve:${IMPACT}:${OFFER_200}`);
  });

  test("concurrent decisions produce one action, not two", async () => {
    await park();
    const results = await Promise.allSettled([decide(), decide()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action`)).toBe(1);
  });
});

describe("guards that run before any write", () => {
  test("an expired offer is refused", async () => {
    await park();
    await env.DB.prepare(`UPDATE offer SET expires_at = ? WHERE id = ?`)
      .bind("2026-09-13T17:00:00Z", OFFER_200) // an hour before NOW
      .run();

    await expect(decide()).rejects.toThrow(/expired/);
    // Nothing was written.
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action`)).toBe(0);
    expect(await scalar<string>(env, `SELECT decided_at FROM approval WHERE id='apr-1'`)).toBeNull();
  });

  test("a drifted itinerary is refused rather than acted on", async () => {
    // DATA_MODEL.md:225 — matched_num_updates exists to catch exactly this.
    await park();
    await env.DB.prepare(
      `UPDATE itinerary SET last_num_updates = 99 WHERE id = 'itin-us-04-f'`,
    ).run();

    await expect(decide()).rejects.toThrow(/changed underneath/);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action`)).toBe(0);
  });

  test("an offer belonging to a different impact is refused", async () => {
    await park();
    const otherOffer = `ofr-${impactIdFor("emp-us-01")}-1`;
    await expect(decide({ offerId: otherOffer })).rejects.toThrow(/does not belong/);
  });

  test("an unknown approval is a 404, not a crash", async () => {
    await expect(
      decideApproval(env as any, { approvalId: "nope", decision: "APPROVED", decidedBy: OP }, NOW),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("every refusal is a typed TransitionError with a code", async () => {
    await park();
    await env.DB.prepare(`UPDATE offer SET expires_at='2026-01-01T00:00:00Z' WHERE id=?`)
      .bind(OFFER_200)
      .run();
    try {
      await decide();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      expect((err as TransitionError).code).toBe("OFFER_EXPIRED");
    }
  });
});

describe("rejection", () => {
  test("REJECTED returns the impact to TRIAGING, not FAILED", async () => {
    await park();
    await decide({ decision: "REJECTED", note: "too expensive, find another" });

    // "Not this option" is not "this traveller is stranded" — there may be
    // others worth offering.
    expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id='${IMPACT}'`)).toBe(
      "TRIAGING",
    );
    expect(
      await scalar<string>(env, `SELECT selected_offer_id FROM disruption_impact WHERE id='${IMPACT}'`),
    ).toBeNull();
  });

  test("a rejection queues no work", async () => {
    await park();
    await decide({ decision: "REJECTED" });
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM action`)).toBe(0);
  });

  test("the rejection and its note are recorded", async () => {
    await park();
    await decide({ decision: "REJECTED", note: "over budget" });
    const row = await env.DB.prepare(
      `SELECT decision, decided_by, note FROM approval WHERE id='apr-1'`,
    ).first<any>();
    expect(row.decision).toBe("REJECTED");
    expect(row.decided_by).toBe(OP);
    expect(row.note).toBe("over budget");
  });
});

describe("the card stops being actionable afterwards", () => {
  test("a decided approval leaves no open approval on the impact", async () => {
    await park();
    await decide();
    const open = await scalar<number>(
      env,
      `SELECT COUNT(*) FROM approval WHERE impact_id='${IMPACT}' AND decided_at IS NULL`,
    );
    expect(open).toBe(0);
  });
});
