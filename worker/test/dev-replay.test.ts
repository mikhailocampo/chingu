/**
 * The demo replay driver.
 *
 * The harness boots D1 only — no Durable Objects — so the CallDO half is served
 * by the fake below. That fake is not a convenience: it is the assertion. It
 * counts appends per dispatch, which is exactly what the resume cursor reads
 * back in production, so a driver that double-emits on a re-run fails here.
 *
 * The DO path proper is verified out-of-band against `wrangler dev --local`.
 *
 * NOTE: no afterAll(shutdown) — see zz-teardown.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, scalar, type TestEnv } from "./harness";
import { disrupt, impactIdFor, DISRUPT_EVENT_ID } from "../src/dev-disrupt";
import {
  buildOps,
  bySession,
  dispatchIdFor,
  parseFrames,
  replay,
  replayReset,
  runTagFor,
  totalDurationMs,
  REAL_CALL_EMPLOYEE_ID,
  REPLAY_EMPLOYEE_IDS,
  REPLAY_TRAVELLERS,
} from "../src/dev-replay";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/vb-frames");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name), "utf8");

/** dispatch.status — schema.sql:271. The literal set, not a paraphrase. */
const LEGAL_STATUS = new Set([
  "QUEUED",
  "DIALING",
  "IN_CALL",
  "RESOLVING",
  "RESOLVED",
  "FAILED",
  "NO_ANSWER",
]);

/* ------------------------------------------------------------- CallDO fake */

interface Emitted {
  kind: string;
  payload: unknown;
  vbTs?: string;
}

/**
 * Stands in for the CALL DurableObjectNamespace.
 *
 * Mirrors the one invariant the driver depends on: every setStatus and every
 * append advances seq by exactly one, and getStatus reports it.
 */
function fakeCallNamespace() {
  const logs = new Map<string, Emitted[]>();
  const inits = new Map<string, { employeeId: string; directive: string }>();

  return {
    logs,
    inits,
    getByName(name: string) {
      let log = logs.get(name);
      if (!log) {
        log = [];
        logs.set(name, log);
      }
      return {
        async init(_id: string, employeeId: string, directive: string) {
          inits.set(name, { employeeId, directive });
          return { ok: true };
        },
        async getStatus() {
          return { lastSeq: log!.length };
        },
        async setStatus(status: string) {
          log!.push({ kind: "status", payload: { status } });
        },
        async append(kind: string, payload: unknown, vbTs?: string) {
          log!.push({ kind, payload, vbTs });
          return log!.length;
        },
      };
    },
  };
}

let env: TestEnv;
let call: ReturnType<typeof fakeCallNamespace>;

/** Fixed, so the run tag — and therefore every id — is stable across a test. */
const NOW = new Date("2026-09-13T18:00:00Z");

beforeEach(async () => {
  env = await boot();
  call = fakeCallNamespace();
});

/**
 * The demo's real order of operations: disrupt, then replay. `speed` collapses
 * the ~74s timeline so the suite exercises the actual walk, sleeps and all,
 * rather than a special-cased fast path.
 */
async function runReplay(speed = 20_000) {
  await disrupt(worker(), NOW);
  return replay(worker(), null, { sync: true, speed });
}

const worker = () => ({ ...env, CALL: call }) as any;

/* ------------------------------------------------------------------ frames */

describe("frame parsing handles the real captured formats", () => {
  test("pool.jsonl — the {t, stream, agent, ev} shape", () => {
    const frames = parseFrames(fixture("pool.jsonl"));

    // 140 lines, all debug_event, none dropped.
    expect(frames).toHaveLength(140);
    expect(frames.every((f) => f.sessionId !== null)).toBe(true);
    expect(frames.every((f) => typeof f.vbTs === "string")).toBe(true);
  });

  test("pool.jsonl carries genuine tool_call / tool_result pairs", () => {
    const frames = parseFrames(fixture("pool.jsonl"));
    const kinds = new Set(frames.map((f) => f.kind));

    for (const k of ["tool_call", "tool_result", "agent_response", "user_transcription"]) {
      expect(kinds.has(k), `pool.jsonl should contain ${k}`).toBe(true);
    }

    // The payload must survive intact — an expanded card renders this.
    const result = frames.find((f) => f.kind === "tool_result")!;
    expect(result.payload).toHaveProperty("name");
    expect(result.payload).toHaveProperty("result");
  });

  test("conc.jsonl — the {t, raw: '<json string>'} shape", () => {
    const frames = parseFrames(fixture("conc.jsonl"));

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.kind === "session_started")).toBe(true);
    // `connected` is a socket handshake, not a call event. IngestDO drops it
    // (index.ts:330) and so must we, or a transcript opens with noise.
    expect(frames.some((f) => f.kind === "connected")).toBe(false);
  });

  test.each(["single.jsonl", "speak.jsonl", "probe.jsonl", "idle.jsonl"])(
    "%s parses without throwing",
    (name) => {
      expect(() => parseFrames(fixture(name))).not.toThrow();
    },
  );

  test("toolhits.jsonl is a different file format entirely and yields nothing", () => {
    // HTTP hit logs, no `ev` and no `raw`. Must be skipped, not misread.
    expect(parseFrames(fixture("toolhits.jsonl"))).toHaveLength(0);
  });

  test("garbage lines are skipped, not fatal", () => {
    const good = fixture("pool.jsonl").split("\n")[0];
    const mixed = ["not json at all", "", "{}", '{"t":1,"raw":"{{{"}', good].join("\n");

    expect(parseFrames(mixed)).toHaveLength(1);
  });

  test("bySession groups pool.jsonl into its eight captured sessions", () => {
    const sessions = bySession(parseFrames(fixture("pool.jsonl")));
    expect(sessions.size).toBe(8);
  });

  test("every traveller's session is present in the embedded fixtures", () => {
    // If the embedded blob at the bottom of dev-replay.ts drifts from the
    // traveller table, cards open on an empty transcript. Catch it here.
    for (const t of REPLAY_TRAVELLERS) {
      const frames = buildOps(t).filter((o) => o.type === "frame");
      expect(frames.length, `${t.employeeId} should replay real frames`).toBeGreaterThan(10);
    }
  });
});

/* ---------------------------------------------------------------- timeline */

describe("the timeline", () => {
  test("every status op uses a literal from the dispatch.status enum", () => {
    for (const t of REPLAY_TRAVELLERS) {
      for (const op of buildOps(t)) {
        if (op.type === "status") expect(LEGAL_STATUS.has(op.status)).toBe(true);
      }
    }
  });

  test("each traveller passes through DIALING and IN_CALL, in that order", () => {
    // The roster derives CALLING from DIALING|IN_CALL (status.ts:80). Skip
    // these and the card never animates.
    for (const t of REPLAY_TRAVELLERS) {
      const statuses = buildOps(t)
        .filter((o) => o.type === "status")
        .map((o) => (o as { status: string }).status);

      expect(statuses).toEqual(["DIALING", "IN_CALL", "RESOLVING", "RESOLVED"]);
    }
  });

  test("ops are emitted in non-decreasing time order", () => {
    for (const t of REPLAY_TRAVELLERS) {
      const times = buildOps(t).map((o) => o.atMs);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  test("frames land between IN_CALL and RESOLVING, never outside the call", () => {
    for (const t of REPLAY_TRAVELLERS) {
      const ops = buildOps(t);
      const inCall = ops.find((o) => o.type === "status" && o.status === "IN_CALL")!.atMs;
      const resolving = ops.find((o) => o.type === "status" && o.status === "RESOLVING")!.atMs;

      for (const op of ops) {
        if (op.type !== "frame") continue;
        expect(op.atMs).toBeGreaterThan(inCall);
        expect(op.atMs).toBeLessThan(resolving);
      }
    }
  });

  test("the three finish staggered, across roughly 30-90 seconds", () => {
    const ends = REPLAY_TRAVELLERS.map((t) => buildOps(t).at(-1)!.atMs);

    expect(new Set(ends).size).toBe(3); // no two land together
    expect(Math.min(...ends)).toBeGreaterThan(30_000);
    expect(Math.max(...ends)).toBeLessThan(90_000);
    expect(totalDurationMs()).toBe(Math.max(...ends));
  });
});

/* --------------------------------------------------------------------- ids */

describe("ids", () => {
  test("the run tag is derived from detected_at and is id-safe", () => {
    const tag = runTagFor("2026-09-13T18:00:00.000Z");

    expect(tag).toMatch(/^[A-Za-z0-9]+$/);
    // Same disruption, same tag: re-POSTing replay resumes rather than restarts.
    expect(runTagFor("2026-09-13T18:00:00.000Z")).toBe(tag);
    // A fresh disrupt refreshes detected_at, so the next demo run gets fresh
    // dispatch ids and therefore fresh (empty) CallDOs.
    expect(runTagFor("2026-09-13T18:04:11.000Z")).not.toBe(tag);
  });
});

/* ------------------------------------------------------- dispatch creation */

describe("dispatch rows", () => {
  test("creates rows for exactly the three simulated travellers", async () => {
    await runReplay();

    const { results } = await env.DB.prepare(
      `SELECT employee_id, kind, impact_id, actor_kind FROM dispatch
        WHERE id LIKE 'dsp-replay-%' ORDER BY employee_id`,
    ).all<{ employee_id: string; kind: string; impact_id: string; actor_kind: string }>();

    expect(results!.map((r) => r.employee_id)).toEqual(["emp-us-02", "emp-us-03", "emp-us-04"]);
    expect(results!.every((r) => r.kind === "CALL_EMPLOYEE")).toBe(true);
    // Linked to the impact, or the roster's dispatch join finds nothing.
    for (const r of results!) {
      expect(r.impact_id).toBe(impactIdFor(r.employee_id));
    }
  });

  test("emp-us-01 is never touched — that one is a REAL phone call", async () => {
    await runReplay();

    expect(REPLAY_EMPLOYEE_IDS).not.toContain(REAL_CALL_EMPLOYEE_ID);

    const n = await scalar<number>(
      env,
      `SELECT COUNT(*) FROM dispatch WHERE employee_id = ?`,
      REAL_CALL_EMPLOYEE_ID,
    );
    expect(n).toBe(0);

    // His impact is left exactly where disrupt put it.
    const state = await scalar<string>(
      env,
      `SELECT state FROM disruption_impact WHERE employee_id = ?`,
      REAL_CALL_EMPLOYEE_ID,
    );
    expect(state).toBe("TRIAGING");

    // And no CallDO was opened for him under any id.
    for (const name of call.logs.keys()) {
      expect(name).not.toContain(REAL_CALL_EMPLOYEE_ID);
    }
  });

  test("statuses land inside the dispatch.status enum", async () => {
    await runReplay();

    const { results } = await env.DB.prepare(
      `SELECT status FROM dispatch WHERE id LIKE 'dsp-replay-%'`,
    ).all<{ status: string }>();

    expect(results!.length).toBe(3);
    for (const r of results!) expect(LEGAL_STATUS.has(r.status)).toBe(true);
  });

  test("all three end at RESOLVED with an outcome summary", async () => {
    await runReplay();

    const { results } = await env.DB.prepare(
      `SELECT status, outcome_summary, resolved_at FROM dispatch WHERE id LIKE 'dsp-replay-%'`,
    ).all<{ status: string; outcome_summary: string | null; resolved_at: string | null }>();

    for (const r of results!) {
      expect(r.status).toBe("RESOLVED");
      expect(r.outcome_summary).toBeTruthy();
      expect(r.resolved_at).toBeTruthy();
    }
  });

  test("refuses to run before the disruption exists", async () => {
    const res = await replay(worker(), null, { sync: true, speed: 20_000 });

    expect(res.status).toBe(409);
    const n = await scalar<number>(env, `SELECT COUNT(*) FROM dispatch`);
    expect(n).toBe(0);
  });
});

/* --------------------------------------------------------------- transcript */

describe("captured frames reach the CallDO", () => {
  test("each traveller's log carries status events AND real transcript frames", async () => {
    await runReplay();
    const tag = runTagFor(NOW.toISOString());

    for (const t of REPLAY_TRAVELLERS) {
      const log = call.logs.get(dispatchIdFor(tag, t.employeeId))!;
      expect(log, `${t.employeeId} should have a CallDO log`).toBeDefined();

      const statuses = log.filter((e) => e.kind === "status");
      expect(statuses).toHaveLength(4);

      expect(log.some((e) => e.kind === "tool_call")).toBe(true);
      expect(log.some((e) => e.kind === "tool_result")).toBe(true);
      expect(log.some((e) => e.kind === "agent_response")).toBe(true);
    }
  });

  test("frames carry VB's original timestamp, and emission follows file order", async () => {
    await runReplay();
    const tag = runTagFor(NOW.toISOString());
    const t = REPLAY_TRAVELLERS[0];
    const log = call.logs.get(dispatchIdFor(tag, t.employeeId))!;

    const emitted = log.filter((e) => e.kind !== "status");
    expect(emitted.every((f) => typeof f.vbTs === "string")).toBe(true);

    // Emission order is the captured file order, verbatim.
    const captured = bySession(parseFrames(fixture("pool.jsonl"))).get(t.sessionId)!;
    expect(emitted.map((e) => e.kind)).toEqual(captured.map((f) => f.kind));
    expect(emitted.map((e) => e.vbTs)).toEqual(captured.map((f) => f.vbTs));
  });

  test("vb_ts is carried but never used to order — it is not a safe key", () => {
    // Worth recording precisely, because the received wisdom overstates it:
    // across all 140 pool.jsonl frames there are ZERO millisecond collisions,
    // and within a session the timestamps are monotonic. The collisions are at
    // SECOND precision — 31 of them — which is exactly the resolution a UI or
    // a log view is likely to group or sort by.
    const frames = parseFrames(fixture("pool.jsonl"));

    const ms = frames.map((f) => f.vbTs!);
    expect(new Set(ms).size).toBe(ms.length);

    const seconds = frames.map((f) => `${f.sessionId}@${f.vbTs!.slice(0, 19)}`);
    expect(new Set(seconds).size).toBeLessThan(seconds.length);

    // So ordering stays positional regardless: the driver emits in captured
    // order and CallDO.append assigns seq via AUTOINCREMENT. Nothing here ever
    // parses vb_ts to decide what comes first.
  });

  test("the log matches the timeline op-for-op — the resume cursor's invariant", async () => {
    await runReplay();
    const tag = runTagFor(NOW.toISOString());

    for (const t of REPLAY_TRAVELLERS) {
      const log = call.logs.get(dispatchIdFor(tag, t.employeeId))!;
      // One event per op, exactly. If this drifts, lastSeq stops meaning
      // "operation index" and resume replays or skips events.
      expect(log).toHaveLength(buildOps(t).length);
    }
  });

  test("the three travellers replay three DIFFERENT captured sessions", async () => {
    const sessions = new Set(REPLAY_TRAVELLERS.map((t) => t.sessionId));
    expect(sessions.size).toBe(3);
  });
});

/* ----------------------------------------------------------------- outcomes */

describe("outcomes show autonomy and escalation side by side", () => {
  test("at least one traveller resolves in policy with NO approval gate", async () => {
    await runReplay();

    const autonomous = REPLAY_TRAVELLERS.filter((t) => t.outcome === "AUTONOMOUS");
    expect(autonomous.length).toBeGreaterThan(0);

    for (const t of autonomous) {
      const impactId = impactIdFor(t.employeeId);

      expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id = ?`, impactId)).toBe(
        "RESOLVED",
      );
      expect(
        await scalar<number>(env, `SELECT COUNT(*) FROM approval WHERE impact_id = ?`, impactId),
        "an autonomous resolution must have no approval row at all",
      ).toBe(0);

      // Resolved against the PASS offer, and money stays a decimal string.
      const verdict = await scalar<string>(
        env,
        `SELECT o.policy_verdict FROM disruption_impact i
           JOIN offer o ON o.id = i.selected_offer_id WHERE i.id = ?`,
        impactId,
      );
      expect(verdict).toBe("PASS");

      const total = await scalar<string>(
        env,
        `SELECT o.total_delta FROM disruption_impact i
           JOIN offer o ON o.id = i.selected_offer_id WHERE i.id = ?`,
        impactId,
      );
      expect(typeof total).toBe("string");
      expect(total).toBe("120.00");
    }
  });

  test("the escalating traveller parks at AWAITING_APPROVAL with an open approval", async () => {
    await runReplay();

    const escalated = REPLAY_TRAVELLERS.filter((t) => t.outcome === "ESCALATED");
    expect(escalated.length).toBeGreaterThan(0);

    for (const t of escalated) {
      const impactId = impactIdFor(t.employeeId);

      expect(await scalar<string>(env, `SELECT state FROM disruption_impact WHERE id = ?`, impactId)).toBe(
        "AWAITING_APPROVAL",
      );

      const apr = await env.DB.prepare(
        `SELECT reason, decided_at, offer_id FROM approval WHERE impact_id = ?`,
      )
        .bind(impactId)
        .first<{ reason: string; decided_at: string | null; offer_id: string }>();

      expect(apr!.reason).toBe("OVER_THRESHOLD");
      // Open, so the coordinator can close it on stage via /api/approval/:id/decide.
      expect(apr!.decided_at).toBeNull();

      const verdict = await scalar<string>(
        env,
        `SELECT policy_verdict FROM offer WHERE id = ?`,
        apr!.offer_id,
      );
      expect(verdict).toBe("NEEDS_APPROVAL");
    }
  });

  test("no card falls back to AT_RISK between the call and the resolution", async () => {
    await runReplay();

    // dispatch.status = RESOLVING derives to no display status of its own
    // (status.ts:80 only claims DIALING|IN_CALL), so during wrap-up the card is
    // rendered from the impact alone. If the impact were still TRIAGING the
    // card would read AT_RISK — CALLING -> AT_RISK -> RESOLVED, which looks
    // like the agent failed and then recovered.
    //
    // So the choice is committed at RESOLVING, not at RESOLVED. previous_state
    // is the receipt that it happened in that order.
    for (const t of REPLAY_TRAVELLERS.filter((x) => x.outcome === "AUTONOMOUS")) {
      const row = await env.DB.prepare(
        `SELECT state, previous_state FROM disruption_impact WHERE id = ?`,
      )
        .bind(impactIdFor(t.employeeId))
        .first<{ state: string; previous_state: string }>();

      expect(row!.state).toBe("RESOLVED");
      // EXECUTING renders as BOOKING (status.ts:96) — a working card, not a
      // failing one.
      expect(row!.previous_state).toBe("EXECUTING");
    }
  });

  test("the escalated card is left for a human — the seam cannot resolve it", async () => {
    await runReplay();

    for (const t of REPLAY_TRAVELLERS.filter((x) => x.outcome === "ESCALATED")) {
      const state = await scalar<string>(
        env,
        `SELECT state FROM disruption_impact WHERE id = ?`,
        impactIdFor(t.employeeId),
      );
      // Only /api/approval/:id/decide can move this. A demo seam resolving it
      // would be the system approving its own spending.
      expect(state).toBe("AWAITING_APPROVAL");
    }
  });

  test("the board ends with both an autonomous resolution and an open gate", async () => {
    await runReplay();

    const resolved = await scalar<number>(
      env,
      `SELECT COUNT(*) FROM disruption_impact WHERE event_id = ? AND state = 'RESOLVED'`,
      DISRUPT_EVENT_ID,
    );
    const awaiting = await scalar<number>(
      env,
      `SELECT COUNT(*) FROM disruption_impact WHERE event_id = ? AND state = 'AWAITING_APPROVAL'`,
      DISRUPT_EVENT_ID,
    );

    expect(resolved).toBeGreaterThan(0);
    expect(awaiting).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------- idempotency */

describe("re-runnable", () => {
  test("firing it twice does not double the dispatch rows", async () => {
    await runReplay();
    await replay(worker(), null, { sync: true, speed: 20_000 });

    const n = await scalar<number>(env, `SELECT COUNT(*) FROM dispatch WHERE id LIKE 'dsp-replay-%'`);
    expect(n).toBe(3);
  });

  test("firing it twice does not double the transcript", async () => {
    await runReplay();
    const tag = runTagFor(NOW.toISOString());
    const before = REPLAY_TRAVELLERS.map((t) => call.logs.get(dispatchIdFor(tag, t.employeeId))!.length);

    await replay(worker(), null, { sync: true, speed: 20_000 });

    const after = REPLAY_TRAVELLERS.map((t) => call.logs.get(dispatchIdFor(tag, t.employeeId))!.length);
    expect(after).toEqual(before);
  });

  test("a partial run resumes from where it stopped rather than restarting", async () => {
    await disrupt(worker(), NOW);
    const tag = runTagFor(NOW.toISOString());
    const dispatchId = dispatchIdFor(tag, REPLAY_TRAVELLERS[0].employeeId);

    // Simulate waitUntil being cut mid-timeline: pre-load the log with the
    // first few ops, exactly as a partial walk would have left it.
    const stub = call.getByName(dispatchId);
    await stub.setStatus("DIALING");
    await stub.setStatus("IN_CALL");

    await replay(worker(), null, { sync: true, speed: 20_000 });

    const log = call.logs.get(dispatchId)!;
    expect(log).toHaveLength(buildOps(REPLAY_TRAVELLERS[0]).length);
    // The two pre-existing ops were not re-emitted.
    expect(log.filter((e) => e.kind === "status")).toHaveLength(4);
  });

  test("two concurrent drivers converge instead of double-writing", async () => {
    await disrupt(worker(), NOW);

    await Promise.all([
      replay(worker(), null, { sync: true, speed: 20_000 }),
      replay(worker(), null, { sync: true, speed: 20_000 }),
    ]);

    const n = await scalar<number>(env, `SELECT COUNT(*) FROM dispatch WHERE id LIKE 'dsp-replay-%'`);
    expect(n).toBe(3);

    for (const t of REPLAY_TRAVELLERS) {
      const log = call.logs.get(dispatchIdFor(runTagFor(NOW.toISOString()), t.employeeId))!;
      expect(log.length).toBeLessThanOrEqual(buildOps(t).length);
    }
  });

  test("a re-fired disruption mints fresh ids, so the transcript starts clean", async () => {
    await runReplay();
    const firstTag = runTagFor(NOW.toISOString());

    // /api/dev/disrupt refreshes detected_at on every fire (dev-disrupt.ts:153).
    const later = new Date("2026-09-13T18:07:42Z");
    await disrupt(worker(), later);
    const secondTag = runTagFor(later.toISOString());

    expect(secondTag).not.toBe(firstTag);
    // Different dispatch id means a different Durable Object, which is the only
    // way to re-run the demo: a CallDO log cannot be emptied.
    expect(dispatchIdFor(secondTag, "emp-us-02")).not.toBe(dispatchIdFor(firstTag, "emp-us-02"));
  });
});

/* ------------------------------------------------------------------- reset */

describe("reset", () => {
  test("removes the dispatch rows and the approvals it opened", async () => {
    await runReplay();
    await replayReset(worker());

    expect(await scalar<number>(env, `SELECT COUNT(*) FROM dispatch WHERE id LIKE 'dsp-replay-%'`)).toBe(0);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM approval WHERE id LIKE 'apr-replay-%'`)).toBe(0);
  });

  test("rewinds the three impacts to TRIAGING so the demo can re-run", async () => {
    await runReplay();
    await replayReset(worker());

    for (const id of REPLAY_EMPLOYEE_IDS) {
      const row = await env.DB.prepare(
        `SELECT state, selected_offer_id, resolved_at FROM disruption_impact WHERE id = ?`,
      )
        .bind(impactIdFor(id))
        .first<{ state: string; selected_offer_id: string | null; resolved_at: string | null }>();

      expect(row!.state).toBe("TRIAGING");
      expect(row!.selected_offer_id).toBeNull();
      expect(row!.resolved_at).toBeNull();
    }
  });

  test("leaves emp-us-01 and the disruption itself alone", async () => {
    await runReplay();
    await replayReset(worker());

    expect(
      await scalar<string>(
        env,
        `SELECT state FROM disruption_impact WHERE employee_id = ?`,
        REAL_CALL_EMPLOYEE_ID,
      ),
    ).toBe("TRIAGING");

    // The cancellation and its offers survive — this reset is narrower than
    // /api/dev/reset on purpose.
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_event WHERE id = ?`, DISRUPT_EVENT_ID)).toBe(1);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM offer`)).toBeGreaterThan(0);
  });

  test("is safe to call when nothing has been replayed", async () => {
    await disrupt(worker(), NOW);
    const res = await replayReset(worker());
    expect(res.status).toBe(200);
  });

  test("/api/dev/reset also clears these rows, via the event's dispatch delete", async () => {
    await runReplay();
    const { reset } = await import("../src/dev-disrupt");
    await reset(worker());

    expect(await scalar<number>(env, `SELECT COUNT(*) FROM dispatch`)).toBe(0);
    expect(await scalar<number>(env, `SELECT COUNT(*) FROM disruption_impact`)).toBe(0);
  });
});
