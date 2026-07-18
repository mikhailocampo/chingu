/**
 * POST /api/dev/replay        — drive three simulated travellers through a call.
 * POST /api/dev/replay/reset  — remove what it created, so the demo can re-run.
 *
 * WHY THIS EXISTS
 * ---------------
 * The demo fires one disruption and catches four travellers. Exactly ONE of
 * them (emp-us-01, Jinhui Kim) gets a real VocalBridge phone call. If the
 * other three sit at AT_RISK while that one phone rings, the board looks dead
 * for ninety seconds — which is the opposite of what the product does.
 *
 * So the other three are walked through DIALING -> IN_CALL -> RESOLVING ->
 * RESOLVED on a timer, and their CallDO event logs are filled with frames
 * CAPTURED FROM REAL VOCALBRIDGE SESSIONS. Opening a simulated card shows a
 * genuine transcript: real tool_call/tool_result pairs, real agent_response
 * text, real background_query round-trips. It is a replay, not a mock.
 *
 * THIS PATH NEVER DIALS
 * ---------------------
 * It touches D1 and CallDO and nothing else. No queue, no assertDialable, no
 * POST /api/v1/calls. A demo seam that accidentally phones a stranger is the
 * worst bug available here, so the capability simply is not imported.
 *
 * THE TIMER PROBLEM
 * -----------------
 * A Worker cannot hold a background timer across requests, and the three
 * travellers must finish at DIFFERENT times — instant flips read as fake.
 *
 * Chosen: `ctx.waitUntil` drives the timeline for as long as the runtime keeps
 * the request context alive, and the endpoint is RESUMABLE, so that cap is not
 * load-bearing. Progress is not tracked in a variable; it is read back from
 * CallDO's own `seq`. Every operation in the timeline appends exactly one event
 * (`setStatus` appends one, `append` appends one), the operation list is
 * deterministic, and nothing else writes these objects — so operation index i
 * has emitted iff `lastSeq >= i + 1`. Re-POSTing /api/dev/replay therefore
 * picks up precisely where it stopped, skips what already happened, and two
 * concurrent drivers converge instead of double-writing. The cursor is
 * re-read before every operation, not once at the start, for that reason.
 *
 * Alarms would have been the other honest answer, but the only DO with an
 * alarm is IngestDO (the VB socket watchdog) and hanging demo scheduling off it
 * would entangle the replay path with the live-call path. This keeps them
 * disjoint.
 *
 * RE-RUNNABILITY, AND WHY IDS CARRY A RUN TAG
 * -------------------------------------------
 * A CallDO's event log is append-only and there is no delete seam, so if the
 * dispatch ids were fixed the second demo run would resume a finished
 * transcript and emit nothing at all. The ids therefore carry a run tag
 * derived from `disruption_event.detected_at` — which /api/dev/disrupt
 * refreshes on every fire (dev-disrupt.ts:153). One reset+disrupt gets fresh
 * objects; re-POSTing replay alone stays on the same run and resumes. No new
 * state anywhere: the run tag is derived, not stored.
 *
 * FIXTURES ARE EMBEDDED, NOT READ
 * -------------------------------
 * A Worker has no filesystem. The frames at the bottom of this file are three
 * complete sessions lifted verbatim out of worker/fixtures/vb-frames/pool.jsonl
 * and parsed at module load by the same parseFrames() the tests run against the
 * real files. Embedding rather than adding a wrangler Text-module rule keeps
 * the deploy independent of an untracked fixtures directory.
 */
import { DISRUPT_EVENT_ID, impactIdFor } from "./dev-disrupt";
import type { Env } from "./index";
import type { DispatchStatus } from "./status";

/* ----------------------------------------------------------------- parsing */

/** One replayable VocalBridge debug event. */
export interface ReplayFrame {
  /** VB's room_name. The join key for a live call; here, just a grouping. */
  sessionId: string | null;
  /** Seconds since capture start. Pacing only — never ordering. */
  t: number;
  /** VB's `event_type`, e.g. tool_call / tool_result / agent_response. */
  kind: string;
  payload: Record<string, unknown>;
  vbTs?: string;
}

/**
 * Parse a captured VB frame log.
 *
 * The fixtures ship in two shapes and both are real:
 *
 *   pool.jsonl, probe.jsonl   {"t":…, "stream":"A", "agent":…, "ev": {…}}
 *   conc/idle/single/speak    {"t":…, "raw": "<the frame as a JSON string>"}
 *
 * toolhits*.jsonl is a third thing entirely (HTTP hit logs, no frame at all)
 * and is skipped rather than mangled. `connected` frames are dropped too: they
 * are socket handshakes, not call events, and IngestDO ignores them the same
 * way (index.ts:330).
 *
 * Tolerant by design — a fixture line we cannot read must not take the demo
 * down.
 */
export function parseFrames(text: string): ReplayFrame[] {
  const out: ReplayFrame[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    let ev: Record<string, unknown> | null = null;
    if (outer.ev && typeof outer.ev === "object") {
      ev = outer.ev as Record<string, unknown>;
    } else if (typeof outer.raw === "string") {
      try {
        ev = JSON.parse(outer.raw) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    if (!ev) continue; // not a frame log (toolhits.jsonl lands here)

    if (ev.type !== "debug_event") continue; // handshake, not a call event
    const kind = typeof ev.event_type === "string" ? ev.event_type : "unknown";

    out.push({
      sessionId: typeof ev.session_id === "string" ? ev.session_id : null,
      t: typeof outer.t === "number" ? outer.t : 0,
      kind,
      payload: (ev.data as Record<string, unknown>) ?? {},
      vbTs: typeof ev.timestamp === "string" ? ev.timestamp : undefined,
    });
  }

  return out;
}

/** Group parsed frames by session, preserving file order within each session. */
export function bySession(frames: ReplayFrame[]): Map<string, ReplayFrame[]> {
  const m = new Map<string, ReplayFrame[]>();
  for (const f of frames) {
    if (!f.sessionId) continue;
    const list = m.get(f.sessionId);
    if (list) list.push(f);
    else m.set(f.sessionId, [f]);
  }
  return m;
}

/* ------------------------------------------------------------------ script */

type Outcome = "AUTONOMOUS" | "ESCALATED";

interface Traveller {
  employeeId: string;
  name: string;
  /** Which captured session this card replays. */
  sessionId: string;
  outcome: Outcome;
  /** Which seeded offer they end up on. dev-disrupt: 1 = PASS, 2 = NEEDS_APPROVAL. */
  offerRank: number;
  /** Milliseconds after the replay epoch that this traveller starts. */
  startAtMs: number;
  /** How long the transcript takes to play out, in ms. */
  callWindowMs: number;
  outcomeSummary: string;
}

/**
 * Never emp-us-01. That is Jinhui Kim, and he gets a real phone call.
 *
 * Two resolve alone and one escalates, deliberately: the whole argument of the
 * product is that the agent handles what it may and stops at the money it may
 * not. A board where everything escalates says the agent is useless; a board
 * where nothing does says nobody is in control. The audience needs to see both
 * next to each other.
 *
 * Priya and Elena take the rank-1 offer ($120 add-collect, PASS against
 * pol-flight's $150 threshold) and resolve with NO approval row at all. Marcus
 * takes the rank-2 offer ($200, over threshold) and parks at AWAITING_APPROVAL
 * with an open approval — a live NEEDS_YOU card the coordinator can approve
 * on stage through the existing /api/approval/:id/decide route.
 *
 * The staggering: starts 0/5/11s, transcripts 20/32/46s, so the three land
 * roughly 34s / 54s / 74s in. They overlap in the middle and finish apart.
 */
const TRAVELLERS: Traveller[] = [
  {
    employeeId: "emp-us-02",
    name: "Priya Natarajan",
    sessionId: "user-ece421c0-agent-25d963c6-api-e207fc48",
    outcome: "AUTONOMOUS",
    offerRank: 1,
    startAtMs: 0,
    callWindowMs: 20_000,
    outcomeSummary: "Accepted Asiana 223. $120 add-collect, within policy — booked without a gate.",
  },
  {
    employeeId: "emp-us-03",
    name: "Marcus Bell",
    sessionId: "user-ece421c0-agent-c123bf95-api-02f30bb1",
    outcome: "ESCALATED",
    offerRank: 2,
    startAtMs: 5_000,
    callWindowMs: 32_000,
    outcomeSummary: "Chose Cathay Pacific 841/416. $200 add-collect — over threshold, parked for approval.",
  },
  {
    employeeId: "emp-us-04",
    name: "Elena Duarte",
    sessionId: "user-ece421c0-agent-25d963c6-api-3eaddf0b",
    outcome: "AUTONOMOUS",
    offerRank: 1,
    startAtMs: 11_000,
    callWindowMs: 46_000,
    outcomeSummary: "Accepted Asiana 223. $120 add-collect, within policy — booked without a gate.",
  },
];

/** Employee ids this seam is allowed to touch. emp-us-01 is not one of them. */
export const REPLAY_EMPLOYEE_IDS = TRAVELLERS.map((t) => t.employeeId);

/** The one traveller on a real call. Named so the guard below is greppable. */
export const REAL_CALL_EMPLOYEE_ID = "emp-us-01";

/** Ring-time before the callee picks up, and the wrap-up after they hang up. */
const DIAL_AT_MS = 1_500;
const ANSWER_AT_MS = 6_000;
const RESOLVING_AFTER_MS = 3_000;
const RESOLVED_AFTER_MS = 5_000;

/* ---------------------------------------------------------------- timeline */

type Op =
  | { atMs: number; type: "status"; status: DispatchStatus }
  | { atMs: number; type: "frame"; kind: string; payload: Record<string, unknown>; vbTs?: string };

const FRAMES = bySession(parseFrames(CAPTURED_FRAMES()));

/**
 * The full operation list for one traveller, in emission order.
 *
 * MUST be deterministic and MUST emit exactly one CallDO event per entry: the
 * resume cursor is `lastSeq`, and it only means "operation index" because those
 * two things hold.
 *
 * Frame pacing is the capture's own inter-frame timing, normalised and scaled
 * into callWindowMs. Bursts stay bursty — a tool_call and its tool_result still
 * land together — which is most of why the replay reads as a real call.
 * Ordering is the captured file order, never the timestamp: VB routinely
 * collides tool_call and tool_result inside one millisecond.
 */
export function buildOps(t: Traveller): Op[] {
  const ops: Op[] = [
    { atMs: t.startAtMs + DIAL_AT_MS, type: "status", status: "DIALING" },
    { atMs: t.startAtMs + ANSWER_AT_MS, type: "status", status: "IN_CALL" },
  ];

  const frames = FRAMES.get(t.sessionId) ?? [];
  const base = t.startAtMs + ANSWER_AT_MS + 500;

  if (frames.length > 0) {
    const t0 = frames[0].t;
    const span = frames[frames.length - 1].t - t0;
    for (const f of frames) {
      const fraction = span > 0 ? (f.t - t0) / span : 0;
      ops.push({
        atMs: base + Math.round(fraction * t.callWindowMs),
        type: "frame",
        kind: f.kind,
        payload: f.payload,
        vbTs: f.vbTs,
      });
    }
  }

  const callEnd = base + t.callWindowMs;
  ops.push({ atMs: callEnd + RESOLVING_AFTER_MS, type: "status", status: "RESOLVING" });
  ops.push({
    atMs: callEnd + RESOLVING_AFTER_MS + RESOLVED_AFTER_MS,
    type: "status",
    status: "RESOLVED",
  });

  return ops;
}

/** When the last traveller finishes, in ms after the epoch. */
export function totalDurationMs(): number {
  return Math.max(...TRAVELLERS.map((t) => buildOps(t).at(-1)!.atMs));
}

/* --------------------------------------------------------------------- ids */

/**
 * Compact `detected_at` into an id-safe run tag: 2026-09-13T18:00:00.000Z
 * becomes 20260913T180000000. Fresh on every /api/dev/disrupt, stable in
 * between — which is exactly the resume-vs-rerun boundary we want.
 */
export function runTagFor(detectedAt: string): string {
  return detectedAt.replace(/[-:]/g, "").replace(/\.(\d+)Z?$/, "$1").replace(/Z$/, "");
}

export function dispatchIdFor(runTag: string, employeeId: string): string {
  return `dsp-replay-${runTag}-${employeeId}`;
}

/** Prefix every row this seam writes shares, so reset can find them all. */
const DISPATCH_PREFIX = "dsp-replay-";

function offerIdFor(employeeId: string, rank: number): string {
  return `ofr-${impactIdFor(employeeId)}-${rank}`;
}

function approvalIdFor(employeeId: string): string {
  return `apr-replay-${impactIdFor(employeeId)}`;
}

function directiveFor(t: Traveller): string {
  return (
    `Call ${t.name}. Their KE82 to Incheon on 14 September was cancelled. ` +
    `Read the three alternatives, confirm one, and do not exceed the policy threshold without approval.`
  );
}

/* ------------------------------------------------------------------- start */

interface ImpactRow {
  id: string;
  employee_id: string;
  detected_at: string;
}

/**
 * Seed the dispatch rows and kick the timeline off.
 *
 * Returns immediately with the schedule; the walk itself runs under waitUntil.
 * Callers that want to block (tests, a curl that must observe the end) pass
 * `sync`.
 */
export async function replay(
  env: Env,
  ctx: ExecutionContext | null,
  opts?: {
    /** Block until the timeline finishes instead of returning immediately. */
    sync?: boolean;
    /**
     * Time divisor. 1 is real time (~74s). Higher compresses the whole
     * timeline, which is how the suite exercises the real walk in milliseconds
     * and how you rehearse the demo without waiting for it.
     */
    speed?: number;
  },
) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.employee_id, e.detected_at
       FROM disruption_impact i
       JOIN disruption_event e ON e.id = i.event_id
      WHERE i.event_id = ?`,
  )
    .bind(DISRUPT_EVENT_ID)
    .all<ImpactRow>();

  const impacts = new Map((results ?? []).map((r) => [r.employee_id, r]));
  if (impacts.size === 0) {
    return Response.json(
      { error: "no impacts for this event — POST /api/dev/disrupt first" },
      { status: 409 },
    );
  }

  const detectedAt = (results ?? [])[0].detected_at;
  const runTag = runTagFor(detectedAt);
  const createdAt = new Date().toISOString();

  const planned = TRAVELLERS.filter((t) => impacts.has(t.employeeId));
  if (planned.length === 0) {
    return Response.json({ error: "none of the simulated travellers were impacted" }, { status: 409 });
  }

  await env.DB.batch(
    planned.map((t) =>
      env.DB
        .prepare(
          // OR IGNORE, and created_at is therefore written exactly once: the
          // first row's created_at IS the replay epoch, so re-POSTing resumes
          // the original timeline instead of restarting it.
          `INSERT OR IGNORE INTO dispatch
             (id, kind, impact_id, employee_id, directive, idempotency_key,
              actor_kind, status, created_at)
           VALUES (?, 'CALL_EMPLOYEE', ?, ?, ?, ?, 'SYSTEM', 'QUEUED', ?)`,
        )
        .bind(
          dispatchIdFor(runTag, t.employeeId),
          impacts.get(t.employeeId)!.id,
          t.employeeId,
          directiveFor(t),
          // UNIQUE. Carries the run tag so a fresh disrupt is a fresh run
          // rather than a constraint violation.
          `replay:${runTag}:${t.employeeId}`,
          createdAt,
        ),
    ),
  );

  const epochRow = await env.DB.prepare(
    `SELECT MIN(created_at) AS epoch FROM dispatch WHERE id LIKE ?`,
  )
    .bind(`${DISPATCH_PREFIX}${runTag}-%`)
    .first<{ epoch: string }>();
  const epoch = Date.parse(epochRow?.epoch ?? createdAt);

  const speed = opts?.speed && opts.speed > 0 ? opts.speed : 1;
  const work = Promise.all(planned.map((t) => walk(env, t, runTag, epoch, speed)));
  if (opts?.sync) await work;
  else if (ctx) ctx.waitUntil(work);
  else void work;

  return Response.json({
    ok: true,
    run_tag: runTag,
    epoch: new Date(epoch).toISOString(),
    total_duration_ms: totalDurationMs(),
    // Stated explicitly so a reader of the response can see the guard held.
    excluded: { employee_id: REAL_CALL_EMPLOYEE_ID, reason: "real VocalBridge call" },
    travellers: planned.map((t) => ({
      employee_id: t.employeeId,
      name: t.name,
      dispatch_id: dispatchIdFor(runTag, t.employeeId),
      outcome: t.outcome,
      session_id: t.sessionId,
      frames: (FRAMES.get(t.sessionId) ?? []).length,
      finishes_at_ms: buildOps(t).at(-1)!.atMs,
    })),
  });
}

/* -------------------------------------------------------------------- walk */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One walk per dispatch, per isolate.
 *
 * The lastSeq cursor makes a SEQUENTIAL re-run correct, but two drivers running
 * at once can both read the cursor before either writes, and then both write.
 * That is a real window: getStatus and append are separate RPCs, so the DO's
 * per-object serialisation does not close it.
 *
 * Someone double-clicking the demo button is the case that matters, and that
 * lands in one isolate, so joining the in-flight promise is the fix. Across
 * isolates the cursor is still the backstop — it narrows a duplicate to at most
 * the one operation that was in flight, rather than a whole second transcript.
 */
const inFlight = new Map<string, Promise<void>>();

function walk(env: Env, t: Traveller, runTag: string, epoch: number, speed = 1): Promise<void> {
  const key = dispatchIdFor(runTag, t.employeeId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = walkOnce(env, t, runTag, epoch, speed).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function walkOnce(env: Env, t: Traveller, runTag: string, epoch: number, speed = 1) {
  const dispatchId = dispatchIdFor(runTag, t.employeeId);
  const stub = env.CALL.getByName(dispatchId);
  const ops = buildOps(t);

  // Idempotent: init only writes meta, never an event, so it cannot move seq
  // and cannot desync the cursor below.
  await stub.init(dispatchId, t.employeeId, directiveFor(t));

  for (let i = 0; i < ops.length; i++) {
    const wait = epoch + ops[i].atMs / speed - Date.now();
    if (wait > 0) await sleep(wait);

    // Re-read every iteration, not once: a second driver (a re-POST, or a
    // retry after waitUntil was cut) is racing us, and whichever gets there
    // first should win the write.
    const { lastSeq } = await stub.getStatus();
    if (lastSeq >= i + 1) continue;

    const op = ops[i];
    if (op.type === "status") {
      await env.DB.prepare(`UPDATE dispatch SET status = ? WHERE id = ?`)
        .bind(op.status, dispatchId)
        .run();
      await stub.setStatus(op.status);

      // The call has ended and the traveller has chosen. The impact must move
      // NOW, not at RESOLVED: dispatch.status = RESOLVING derives to no display
      // status of its own, so an impact still sitting at TRIAGING renders the
      // card as AT_RISK for the whole wrap-up. Watching a card go
      // CALLING -> AT_RISK -> RESOLVED reads as the agent failing and then
      // recovering, which is the opposite of the story.
      if (op.status === "RESOLVING") await commitChoice(env, t);
    } else {
      await stub.append(op.kind, op.payload, op.vbTs);
    }
  }

  await finish(env, t, dispatchId);
}

/* ------------------------------------------------------------------ finish */

/** States a replayed impact is still allowed to be advanced out of. */
const PRE_DECISION = "('DETECTED','TRIAGING','CONTACTING')";

/**
 * The traveller has picked an option on the phone. Record the choice and split
 * on whether it needs a human.
 *
 * Guarded on PRE_DECISION throughout, so a coordinator who acted mid-replay is
 * never overwritten: an impact already at EXECUTING, AWAITING_APPROVAL or
 * RESOLVED got there by a real decision and this seam has nothing to add. That
 * also makes it idempotent, which is what lets finish() call it again to
 * backfill a resume that skipped the RESOLVING op.
 */
async function commitChoice(env: Env, t: Traveller) {
  const now = new Date().toISOString();
  const impactId = impactIdFor(t.employeeId);
  const offerId = offerIdFor(t.employeeId, t.offerRank);

  if (t.outcome === "AUTONOMOUS") {
    // EXECUTING -> the card renders BOOKING. Commit 7dd6ba5 added this state
    // for exactly this gap: chosen, but not yet ticketed. No approval row is
    // written at all — that is the autonomy half of the demo. $120 against
    // pol-flight's $150 threshold, and nobody was asked.
    await env.DB
      .prepare(
        `UPDATE disruption_impact
            SET previous_state = state, state = 'EXECUTING', state_changed_at = ?,
                selected_offer_id = ?
          WHERE id = ? AND state IN ${PRE_DECISION}`,
      )
      .bind(now, offerId, impactId)
      .run();
    return;
  }

  // The escalation half. The gate opens the moment the call wraps, so the
  // NEEDS_YOU card appears while the coordinator is still watching the board.
  //
  // OR IGNORE: re-running must not open a second gate on the same impact, and
  // must not reopen one a coordinator has already closed.
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO approval (id, impact_id, offer_id, reason, requested_at)
         VALUES (?, ?, ?, 'OVER_THRESHOLD', ?)`,
      )
      .bind(approvalIdFor(t.employeeId), impactId, offerId, now),
    env.DB
      .prepare(
        `UPDATE disruption_impact
            SET previous_state = state, state = 'AWAITING_APPROVAL',
                state_changed_at = ?, selected_offer_id = ?
          WHERE id = ? AND state IN ${PRE_DECISION}`,
      )
      .bind(now, offerId, impactId),
  ]);
}

/**
 * Land the dispatch, and — for the two in-policy travellers — the impact.
 *
 * The escalated one deliberately stops here: it stays AWAITING_APPROVAL with an
 * open gate, and only /api/approval/:id/decide can close it. Resolving it from
 * a demo seam would be the system approving its own spending.
 */
export async function finish(env: Env, t: Traveller, dispatchId: string) {
  // Backfill: a resume that skipped past the RESOLVING op never ran this.
  // Idempotent by the PRE_DECISION guard.
  await commitChoice(env, t);

  const now = new Date().toISOString();

  const statements = [
    env.DB.prepare(
      `UPDATE dispatch SET outcome_summary = ?, resolved_at = ? WHERE id = ?`,
    ).bind(t.outcomeSummary, now, dispatchId),
  ];

  if (t.outcome === "AUTONOMOUS") {
    statements.push(
      env.DB
        .prepare(
          `UPDATE disruption_impact
              SET previous_state = state, state = 'RESOLVED', state_changed_at = ?,
                  resolved_at = ?
            WHERE id = ? AND state = 'EXECUTING'`,
        )
        .bind(now, now, impactIdFor(t.employeeId)),
    );
  }

  await env.DB.batch(statements);
}

/* ------------------------------------------------------------------- reset */

/**
 * Undo everything this seam wrote and rewind the three impacts to TRIAGING.
 *
 * Deliberately a SEPARATE route from /api/dev/reset rather than folded into it:
 * that one wipes the disruption entirely, and mid-demo you often want to replay
 * the three cards again without re-firing the cancellation and losing the real
 * call's state. /api/dev/reset still cleans these rows up as a side effect —
 * it already deletes every dispatch for the event (dev-disrupt.ts:259).
 *
 * What it CANNOT undo is the CallDO transcripts; there is no delete seam on an
 * append-only log. That is handled by the run tag instead: the next
 * /api/dev/disrupt mints new dispatch ids, hence new Durable Objects.
 */
export async function replayReset(env: Env): Promise<Response> {
  const ids = REPLAY_EMPLOYEE_IDS.map((e) => impactIdFor(e));
  const placeholders = ids.map(() => "?").join(",");

  await env.DB.batch([
    env.DB
      .prepare(`DELETE FROM approval WHERE id LIKE 'apr-replay-%' AND impact_id IN (${placeholders})`)
      .bind(...ids),
    env.DB.prepare(`DELETE FROM dispatch WHERE id LIKE '${DISPATCH_PREFIX}%'`),
    env.DB
      .prepare(
        `UPDATE disruption_impact
            SET previous_state = state, state = 'TRIAGING', state_changed_at = ?,
                selected_offer_id = NULL, resolved_at = NULL
          WHERE id IN (${placeholders})`,
      )
      .bind(new Date().toISOString(), ...ids),
  ]);

  return Response.json({ ok: true, reset: REPLAY_EMPLOYEE_IDS });
}

export const REPLAY_TRAVELLERS = TRAVELLERS;

/* ---------------------------------------------------------------- fixtures */

/**
 * Three complete VocalBridge sessions, verbatim from
 * worker/fixtures/vb-frames/pool.jsonl — 59 of the 140 captured frames.
 *
 * Chosen because each one is whole: session_started through session_ended, with
 * real get_brief tool_call/tool_result pairs, background_query round-trips,
 * user_transcription and agent_response. Two are from agent 25d963c6 (stream A)
 * and one from c123bf95 (stream B), so the three cards are not the same call
 * three times.
 *
 * Kept in the original wire format rather than pre-digested so parseFrames()
 * above runs on it at module load, exactly as it runs on the fixture files in
 * the test suite. If the parser breaks, the demo breaks loudly at boot instead
 * of quietly showing empty transcripts.
 *
 * Do not reformat: these are captured bytes.
 */
function CAPTURED_FRAMES(): string {
  // String.raw, not a plain template literal. These lines contain JSON string
  // escapes -- \n inside a tool_result body, \" inside an arguments blob -- and
  // a plain literal would turn them into real newlines and quotes before
  // JSON.parse ever saw them, splitting single frames across lines.
  return String.raw`
{"t": 90.96, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "session_started", "data": {"started_at": "2026-07-18T19:03:26.610967", "participant_identity": null}, "timestamp": "2026-07-18T19:03:26.616805+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 91.253, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "get_brief", "arguments": "{}"}, "timestamp": "2026-07-18T19:03:27.908673+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 93.454, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "Retrieve the travel brief for the current caller, including their name, what happened to their trip, and the options available.", "job_id": "80a63d6b-f893-4897-867c-9b4d8bd60765"}, "timestamp": "2026-07-18T19:03:30.317601+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 95.653, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "get_brief", "arguments": "{}"}, "timestamp": "2026-07-18T19:03:32.370186+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 95.653, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "get_brief", "result": "{\n  \"dispatch_id\": \"dispatch_AAA111\",\n  \"employee_name\": \"Priya Raman\",\n  \"employee_id\": \"E-88801\",\n  \"situation\": \"Korean Air 81 from Seoul Incheon to New York JFK on 10 August was cancelled.\",\n  \"objective\": \"Offer exactly three alternatives and confirm one.\",\n  \"options\": [\n    {\n      \"ref\": \"A1\",\n      \"flight\": \"Korean Air 85\",\n      \"depart\": \"19:30 same day\",\n      \"change_cost_usd\": 101.0\n    },\n    {\n      \"ref\": \"A2\",\n      \"flight\": \"Korean Air 5033 via Minneapolis\",\n      \"depart\": \"11:05 same day\",\n      \"change_cost_usd\": 153.8\n    },\n    {\n      \"ref\": \"A3\",\n      \"flight\": \"Delta 7841\",\n      \"depart\": \"20:15 same day\",\n      \"change_cost_usd\": 0.0\n    }\n  ]\n}", "is_error": false}, "timestamp": "2026-07-18T19:03:32.599397+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 97.886, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Hello, this is the Samsung travel desk. One moment please while I gather the details of your situation. Please hold on."}, "timestamp": "2026-07-18T19:03:34.528553+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 97.886, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"Retrieve the travel brief for the current caller, including their name, what happened to their trip, and the options available.\"}"}, "timestamp": "2026-07-18T19:03:34.626073+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 100.66, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "I'm pulling up the information now. While we wait, is"}, "timestamp": "2026-07-18T19:03:37.285516+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 100.661, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "80a63d6b-f893-4897-867c-9b4d8bd60765", "result": "Sure! Let me pull up the travel brief right away.Here is the full travel brief for the current caller:\n\n**Traveller:** Priya Raman (Employee ID: E-88801)\n**Dispatch ID:** AAA111\n\n**Situation:** Priya's original flight, Korean Air 81 from Seoul Incheon to New York JFK on August 10th, has been cancelled.\n\n**Objective:** Offer exactly three alternative flight options and confirm her choice. The three options are:\n\nFirst, Option A1: Korean Air 85, departing at 7:30 PM the same day, with a change cost of 101 dollars.\n\nSecond, Option A2: Korean Air 5033 via Minneapolis, departing at 11:05 AM the same day, with a change cost of 153 dollars and 80 cents.\n\nThird, Option A3: Delta 7841, departing at 8:15 PM the same day, with no change cost \u2014 it's free.\n\nOnce Priya selects one of these options, confirm her choice using the confirm choice function and wrap up the call.", "success": true}, "timestamp": "2026-07-18T19:03:37.484351+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 105.064, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Hello, yes. speaking. What is this about?"}, "timestamp": "2026-07-18T19:03:41.588495+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 111.712, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "I'm currently pulling up the details to understand what happened with your trip. It should just take a moment. While we wait, how are you doing today?"}, "timestamp": "2026-07-18T19:03:48.262284+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 121.843, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Alright, I've got the details now. Priya, your original flight, Korean Air 81 from Seoul Incheon to New York JFK on"}, "timestamp": "2026-07-18T19:03:58.481958+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 125.923, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "Please confirm Priya Raman's selection of option A1: Korean Air 85 departing at 7:30 PM with a change cost of 101 dollars.", "job_id": "11a5d8af-86a0-4935-83dd-4807fdb37ac4"}, "timestamp": "2026-07-18T19:04:02.435856+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 125.923, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Okay, let us go with the first option please."}, "timestamp": "2026-07-18T19:04:02.556876+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 125.923, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"Please confirm Priya Raman's selection of option A1: Korean Air 85 departing at 7:30 PM with a change cost of 101 dollars.\"}"}, "timestamp": "2026-07-18T19:04:02.656832+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 128.113, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "confirm_choice", "arguments": "{}"}, "timestamp": "2026-07-18T19:04:04.820328+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 128.678, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "confirm_choice", "result": "{\n  \"confirmed\": true,\n  \"dispatch_id\": \"dispatch_AAA111\"\n}", "is_error": false}, "timestamp": "2026-07-18T19:04:05.315179+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 131.461, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "11a5d8af-86a0-4935-83dd-4807fdb37ac4", "result": "Sure! Recording Priya's selection right now.Priya Raman's selection has been successfully confirmed. Here's a summary:\n\n**Confirmed Choice:** Option A1 \u2014 Korean Air 85, departing Seoul Incheon at 7:30 PM on August 10th, with a change cost of 101 dollars. The confirmation is tied to Dispatch ID AAA111. The call can now be wrapped up.", "success": true}, "timestamp": "2026-07-18T19:04:07.945264+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 135.868, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Thanks for letting me know your choice, Priya. I'm confirming that now. Please hold on just a moment. While I finalize this, is there anything else you'd like to mention about your travel plans?"}, "timestamp": "2026-07-18T19:04:12.751399+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 147.684, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "session_started", "data": {"started_at": "2026-07-18T19:04:23.003823", "participant_identity": null}, "timestamp": "2026-07-18T19:04:23.010282+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 147.684, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "get_brief", "job_id": "2e40811b-b0cb-4bca-bcb0-368e34270e03"}, "timestamp": "2026-07-18T19:04:24.132521+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 147.788, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"get_brief\"}"}, "timestamp": "2026-07-18T19:04:24.287874+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 148.665, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "session_started", "data": {"started_at": "2026-07-18T19:04:25.054143", "participant_identity": null}, "timestamp": "2026-07-18T19:04:25.060023+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 149.216, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{}"}, "timestamp": "2026-07-18T19:04:26.062099+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 149.98, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "get_brief", "arguments": "{}"}, "timestamp": "2026-07-18T19:04:26.554347+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 150.317, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "get_brief", "job_id": "4c961b52-f803-4225-b6d1-19aae96d7b6e"}, "timestamp": "2026-07-18T19:04:26.708349+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 150.317, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"get_brief\"}"}, "timestamp": "2026-07-18T19:04:26.865459+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 150.53, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "get_brief", "result": "{\n  \"dispatch_id\": \"dispatch_AAA111\",\n  \"employee_name\": \"Priya Raman\",\n  \"employee_id\": \"E-88801\",\n  \"situation\": \"Korean Air 81 from Seoul Incheon to New York JFK on 10 August was cancelled.\",\n  \"objective\": \"Offer exactly three alternatives and confirm one.\",\n  \"options\": [\n    {\n      \"ref\": \"A1\",\n      \"flight\": \"Korean Air 85\",\n      \"depart\": \"19:30 same day\",\n      \"change_cost_usd\": 101.0\n    },\n    {\n      \"ref\": \"A2\",\n      \"flight\": \"Korean Air 5033 via Minneapolis\",\n      \"depart\": \"11:05 same day\",\n      \"change_cost_usd\": 153.8\n    },\n    {\n      \"ref\": \"A3\",\n      \"flight\": \"Delta 7841\",\n      \"depart\": \"20:15 same day\",\n      \"change_cost_usd\": 0.0\n    }\n  ]\n}", "is_error": false}, "timestamp": "2026-07-18T19:04:27.174225+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 153.067, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "get_brief", "arguments": "{}"}, "timestamp": "2026-07-18T19:04:29.717519+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 153.068, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "get_brief", "result": "{\n  \"dispatch_id\": \"dispatch_BBB222\",\n  \"employee_name\": \"Marcus Webb\",\n  \"employee_id\": \"E-44409\",\n  \"situation\": \"Asiana 222 from Seoul Incheon to San Francisco on 12 August was delayed by nine hours.\",\n  \"objective\": \"Confirm whether he wants to rebook or keep the delayed flight.\",\n  \"options\": [\n    {\n      \"ref\": \"B1\",\n      \"flight\": \"Asiana 224\",\n      \"depart\": \"next morning 09:40\",\n      \"change_cost_usd\": 0.0\n    },\n    {\n      \"ref\": \"B2\",\n      \"flight\": \"United 892\",\n      \"depart\": \"22:10 same day\",\n      \"change_cost_usd\": 240.5\n    }\n  ]\n}", "is_error": false}, "timestamp": "2026-07-18T19:04:29.998719+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 153.317, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Hello, this is the Samsung travel desk. One moment while I pull up the details for your trip."}, "timestamp": "2026-07-18T19:04:29.917907+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 154.802, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Hello, this is the Samsung travel desk. One moment while I pull up your details."}, "timestamp": "2026-07-18T19:04:31.371685+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 155.584, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "2e40811b-b0cb-4bca-bcb0-368e34270e03", "result": "I'll retrieve the brief right away!The brief has been retrieved. Here is a full summary for the foreground agent:\n\nThe traveller is Priya Raman, employee ID E-88801. Her flight, Korean Air 81 from Seoul Incheon to New York JFK on August 10th, has been cancelled.\n\nThere are exactly three alternatives to offer her:\n\nOption A1 is Korean Air 85, departing at 7:30 PM the same day, with a change cost of 101 dollars.\n\nOption A2 is Korean Air 5033 via Minneapolis, departing at 11:05 AM the same day, with a change cost of 153 dollars and 80 cents.\n\nOption A3 is Delta 7841, departing at 8:15 PM the same day, with no change cost \u2014 it is free.\n\nOnce Priya selects one of these options, call confirm_choice to lock it in.", "success": true}, "timestamp": "2026-07-18T19:04:31.960126+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 157.202, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Okay, I've got that"}, "timestamp": "2026-07-18T19:04:33.903894+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 158.07, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "4c961b52-f803-4225-b6d1-19aae96d7b6e", "result": "I'll retrieve the brief right away!Here's the brief for the foreground agent:\n\nYou are calling Marcus Webb, employee ID E-44409. His Asiana flight 222 from Seoul Incheon to San Francisco on August 12th has been delayed by nine hours. You need to find out whether he wants to rebook or keep the delayed flight.\n\nYou have two options to offer him. Option one is Asiana 224, departing the next morning at 9:40, at no additional cost. Option two is United 892, departing the same day at 10:10 PM, for an additional cost of 240 dollars and 50 cents. When he makes his choice, call confirm_choice.", "success": true}, "timestamp": "2026-07-18T19:04:34.691859+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 158.295, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "session_ended", "data": {"ended_at": "2026-07-18T19:04:35.180100", "message_count": null, "duration_seconds": null}, "timestamp": "2026-07-18T19:04:35.180124+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-e207fc48"}}
{"t": 161.602, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Hello? Yes speaking. What is this about?"}, "timestamp": "2026-07-18T19:04:38.458697+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 163.645, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Hello? Yes speaking. What is this about?"}, "timestamp": "2026-07-18T19:04:39.962431+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 178.658, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Hi Priya, thanks for your patience. Your flight, Korean Air 81 from Seoul Incheon to New York JFK on August tenth, was unfortunately cancelled. I have three alternative flights for you to consider, along with their costs. Option A1 is Korean Air 85, departing at seven"}, "timestamp": "2026-07-18T19:04:55.099922+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 180.322, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Marcus, your Asiana flight 222 from Seoul Incheon to San Francisco on August 12th has been delayed by about nine hours. We can either rebook you or keep you on the delayed flight. \n\nOption one is Asiana flight 224, departing the next morning at nine forty, at no extra cost. Option"}, "timestamp": "2026-07-18T19:04:56.829984+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 181.952, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "confirm_choice", "arguments": "{\"choice\": \"A1\"}"}, "timestamp": "2026-07-18T19:04:58.734209+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 182.497, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Okay, let us go with the first option please."}, "timestamp": "2026-07-18T19:04:59.043885+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 183.056, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "Confirm Priya Raman's choice of Option A1 for her cancelled flight, and lock it in.", "job_id": "71b34e75-1f75-4b6d-b380-4bb2374a4e63"}, "timestamp": "2026-07-18T19:04:59.543392+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 183.056, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"Confirm Priya Raman's choice of Option A1 for her cancelled flight, and lock it in.\"}"}, "timestamp": "2026-07-18T19:04:59.658646+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 184.224, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "user_transcription", "data": {"is_final": true, "transcript": "Okay, let us go with the first option please."}, "timestamp": "2026-07-18T19:05:00.702017+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 184.225, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "background_query", "data": {"query": "confirm_choice for Marcus Webb, employee ID E-44409, selecting Asiana 224 departing next morning at 9:40 at no additional cost.", "job_id": "04bda4d3-cedf-410c-b5bb-82914687b3d6"}, "timestamp": "2026-07-18T19:05:00.829351+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 184.225, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "submit_background_query", "arguments": "{\"question\": \"confirm_choice for Marcus Webb, employee ID E-44409, selecting Asiana 224 departing next morning at 9:40 at no additional cost.\"}"}, "timestamp": "2026-07-18T19:05:00.970361+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 185.242, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "confirm_choice", "arguments": "{}"}, "timestamp": "2026-07-18T19:05:01.787539+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 185.242, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "confirm_choice", "result": "{\n  \"confirmed\": true,\n  \"dispatch_id\": \"dispatch_AAA111\"\n}", "is_error": false}, "timestamp": "2026-07-18T19:05:02.038844+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 186.41, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_call", "data": {"name": "confirm_choice", "arguments": "{}"}, "timestamp": "2026-07-18T19:05:03.096728+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 186.958, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "tool_result", "data": {"name": "confirm_choice", "result": "{\n  \"confirmed\": true,\n  \"dispatch_id\": \"dispatch_BBB222\"\n}", "is_error": false}, "timestamp": "2026-07-18T19:05:03.542801+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 187.998, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "71b34e75-1f75-4b6d-b380-4bb2374a4e63", "result": "Sure! Locking in Option A1 for Priya Raman right now.Done! Priya Raman's choice has been confirmed. She is booked on Korean Air 85, departing at 7:30 PM on August 10th, with a change cost of 101 dollars. The dispatch ID for this booking is AAA111. The call can now be wrapped up.", "success": true}, "timestamp": "2026-07-18T19:05:04.526191+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 188.631, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Got it, Marcus. I'm confirming that choice now. It\u2019ll just take a moment."}, "timestamp": "2026-07-18T19:05:05.211782+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 189.681, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Alright Priya, I'm confirming that first option for you now. While that processes, how are you feeling about the change?"}, "timestamp": "2026-07-18T19:05:06.440838+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 192.969, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "background_result", "data": {"job_id": "04bda4d3-cedf-410c-b5bb-82914687b3d6", "result": "Sure, confirming that choice now!The choice has been confirmed. Here's a summary for the foreground agent:\n\nMarcus Webb, employee ID E-44409, has been successfully rebooked onto Asiana 224, departing the next morning at 9:40, at no additional cost. The confirmation dispatch ID is dispatch BBB222. You can let Marcus know his rebooking is confirmed and wish him a smooth trip. The call can now be closed.", "success": true}, "timestamp": "2026-07-18T19:05:06.764692+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 194.729, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Good news, Priya \u2013 your seat on"}, "timestamp": "2026-07-18T19:05:11.232209+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}
{"t": 196.076, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "agent_response", "data": {"text": "Alright, Marcus, your rebooking is confirmed onto Asiana flight 224, departing tomorrow"}, "timestamp": "2026-07-18T19:05:12.950066+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 218.352, "stream": "B", "agent": "c123bf95-f4a9-401f-9f93-8bc77591ffe2", "ev": {"type": "debug_event", "event_type": "session_ended", "data": {"ended_at": "2026-07-18T19:05:34.940307", "message_count": null, "duration_seconds": null}, "timestamp": "2026-07-18T19:05:34.940331+00:00", "session_id": "user-ece421c0-agent-c123bf95-api-02f30bb1"}}
{"t": 219.046, "stream": "A", "agent": "25d963c6-ecab-4330-8129-bbfea779f68c", "ev": {"type": "debug_event", "event_type": "session_ended", "data": {"ended_at": "2026-07-18T19:05:35.574497", "message_count": null, "duration_seconds": null}, "timestamp": "2026-07-18T19:05:35.574526+00:00", "session_id": "user-ece421c0-agent-25d963c6-api-3eaddf0b"}}`.trim();
}
