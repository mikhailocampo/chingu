/**
 * Chingu dispatch worker.
 *
 * Data flow, all of it verified against live VocalBridge behaviour:
 *
 *   disruption -> D1 query -> Queue -> consumer -> POST /api/v1/calls
 *                                                       |
 *   VB debug WS (ONE per agent) -> IngestDO -> demux -> CallDO -> SSE -> browser
 *
 * The join between a dispatch and its live events is `room_name`: the call API
 * returns it, and every debug event carries the same string in `session_id`.
 */
import { DurableObject } from "cloudflare:workers";
import { assertDialable, NotAllowlisted } from "./allowlist";
import { disrupt, reset } from "./dev-disrupt";
import { replay, replayReset } from "./dev-replay";
import { getRoster } from "./roster";
import { placeCall, releaseCall } from "./dev-call";
import { drainActions } from "./actions";
import { decideApproval, TransitionError, type Decision } from "./transitions";

export interface Env {
  INGEST: DurableObjectNamespace<IngestDO>;
  CALL: DurableObjectNamespace<CallDO>;
  DB: D1Database;
  DISPATCH_Q: Queue<DispatchJob>;
  VB_API_KEY: string;
  VB_AGENT_ID: string;
  /** Comma-separated E.164 numbers we are permitted to dial. See allowlist.ts. */
  DIAL_ALLOWLIST?: string;
  /** "true" enables /api/dev/*. Never set in production. */
  ENABLE_DEV_ROUTES?: string;
}

interface DispatchJob {
  dispatchId: string;
  employeeId: string;
  phone: string;
  directive: string;
}

/** A debug frame as VB actually sends it (shape captured from a live call). */
interface VBFrame {
  type: "connected" | "debug_event";
  event_type?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  session_id?: string;
}

const VB_BASE = "https://vocalbridgeai.com";

/**
 * Who approvals are attributed to. Resolved server-side and never accepted from
 * a request body: `approval.decided_by` is the audit trail for a real charge.
 * v1 has no session layer, so this is the seeded coordinator (Hyejin Cho).
 */
const OPERATOR_ID = "op-coord";

/**
 * Advance a dispatch in BOTH places, D1 first.
 *
 * D1 is the truth the dashboard reads; CallDO's copy is display-only for the
 * live stream. The consumer used to call only CallDO.setStatus, so
 * dispatch.status sat at QUEUED forever and the roster could never render a
 * call actually happening — the card fell back to its impact state and looked
 * stuck. One writer, one truth, and the truth is D1.
 */
async function advance(env: Env, dispatchId: string, status: string) {
  await env.DB.prepare(
    `UPDATE dispatch SET status = ?,
            resolved_at = CASE WHEN ? IN ('RESOLVED','FAILED','NO_ANSWER')
                               THEN ? ELSE resolved_at END
      WHERE id = ?`,
  )
    .bind(status, status, new Date().toISOString(), dispatchId)
    .run();
  await env.CALL.getByName(dispatchId).setStatus(status);
}

/* ------------------------------------------------------------------ CallDO */

/**
 * One per dispatch. Append-only event log plus SSE fan-out.
 *
 * Named by dispatchId, not by session, so the object exists from the moment
 * work is enqueued -- the agent screen is openable before VB knows anything.
 */
export class CallDO extends DurableObject<Env> {
  private clients = new Set<WritableStreamDefaultWriter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        vb_ts      TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)
    `);
  }

  private getMeta(k: string): string | null {
    const r = this.ctx.storage.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)
      .toArray();
    return r.length ? r[0].v : null;
  }

  private setMeta(k: string, v: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }

  /** Called by the queue consumer once the dispatch row exists. */
  async init(dispatchId: string, employeeId: string, directive: string) {
    this.setMeta("dispatch_id", dispatchId);
    this.setMeta("employee_id", employeeId);
    this.setMeta("directive", directive);
    if (!this.getMeta("status")) this.setMeta("status", "QUEUED");
    return { ok: true };
  }

  async setStatus(status: string) {
    this.setMeta("status", status);
    await this.append("status", { status });
  }

  async getStatus() {
    return {
      dispatchId: this.getMeta("dispatch_id"),
      status: this.getMeta("status"),
      roomName: this.getMeta("room_name"),
      lastSeq: this.lastSeq(),
    };
  }

  private lastSeq(): number {
    const r = this.ctx.storage.sql
      .exec<{ s: number | null }>("SELECT MAX(seq) AS s FROM events")
      .toArray();
    return r[0]?.s ?? 0;
  }

  /**
   * Append one event and push it to every attached SSE client.
   *
   * seq is assigned by SQLite, not derived from VB's timestamp: tool_call and
   * tool_result routinely share a millisecond, and VB's clock is not ours.
   */
  async append(kind: string, payload: unknown, vbTs?: string) {
    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO events (kind, payload, vb_ts, created_at) VALUES (?, ?, ?, ?) RETURNING seq",
        kind,
        JSON.stringify(payload),
        vbTs ?? null,
        Date.now(),
      )
      .one();

    const frame = this.sse(row.seq, kind, payload, vbTs);
    await this.broadcast(frame);
    return row.seq;
  }

  private sse(seq: number, kind: string, payload: unknown, vbTs?: string) {
    const body = JSON.stringify({ seq, kind, payload, vb_ts: vbTs ?? null });
    return `id: ${seq}\nevent: ${kind}\ndata: ${body}\n\n`;
  }

  private async broadcast(text: string) {
    const enc = new TextEncoder().encode(text);
    const dead: WritableStreamDefaultWriter[] = [];
    for (const w of this.clients) {
      try {
        await w.write(enc);
      } catch {
        dead.push(w);
      }
    }
    for (const w of dead) this.clients.delete(w);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/stream")) return this.stream(req, url);
    return new Response("not found", { status: 404 });
  }

  /**
   * SSE egress. Resume is native: the browser replays Last-Event-ID on
   * reconnect, so we backfill everything after that cursor and then go live.
   * A dispatcher opening the screen mid-call gets the full history, not just
   * whatever happens after they connected.
   */
  private stream(req: Request, url: URL): Response {
    const hdr = req.headers.get("Last-Event-ID") ?? url.searchParams.get("cursor");
    const cursor = hdr ? parseInt(hdr, 10) : 0;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    const backlog = this.ctx.storage.sql
      .exec<{ seq: number; kind: string; payload: string; vb_ts: string | null }>(
        "SELECT seq, kind, payload, vb_ts FROM events WHERE seq > ? ORDER BY seq",
        Number.isFinite(cursor) ? cursor : 0,
      )
      .toArray();

    (async () => {
      try {
        await writer.write(enc.encode(": connected\n\n"));
        for (const e of backlog) {
          await writer.write(
            enc.encode(this.sse(e.seq, e.kind, JSON.parse(e.payload), e.vb_ts ?? undefined)),
          );
        }
        this.clients.add(writer);
      } catch {
        /* client vanished before backfill finished */
      }
    })();

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }
}

/* ---------------------------------------------------------------- IngestDO */

/**
 * Singleton. Holds ONE WebSocket to the agent-scoped VB debug stream and fans
 * events out to the right CallDO by room_name.
 *
 * Two facts drive the design, both measured:
 *  - the debug token is minted per AGENT and expires in 3600s
 *  - an outbound WS only keeps a DO alive for 15 minutes, and VB sends no
 *    application-level keepalive while idle
 * so the alarm below is load-bearing, not decoration.
 */
export class IngestDO extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connectedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        room_name   TEXT PRIMARY KEY,
        dispatch_id TEXT NOT NULL,
        bound_at    INTEGER NOT NULL
      )
    `);
  }

  /** Bind a room_name to a dispatch. Called the instant the call API returns. */
  async bind(roomName: string, dispatchId: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO routes (room_name, dispatch_id, bound_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(room_name) DO UPDATE SET dispatch_id = excluded.dispatch_id",
      roomName,
      dispatchId,
      Date.now(),
    );
    await this.ensureConnected();
    return { ok: true };
  }

  private route(roomName: string): string | null {
    const r = this.ctx.storage.sql
      .exec<{ dispatch_id: string }>(
        "SELECT dispatch_id FROM routes WHERE room_name = ?",
        roomName,
      )
      .toArray();
    return r.length ? r[0].dispatch_id : null;
  }

  async ensureConnected() {
    // Reconnect if never connected, dropped, or approaching the 15-minute cap
    // at which an outbound WS stops holding this object in memory.
    const stale = Date.now() - this.connectedAt > 10 * 60 * 1000;
    if (this.ws && !stale) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    await this.connect();
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  private async connect() {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;

    const tokRes = await fetch(`${VB_BASE}/api/v1/debug/token`, {
      method: "POST",
      headers: {
        "X-API-Key": this.env.VB_API_KEY,
        "X-Agent-Id": this.env.VB_AGENT_ID,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (!tokRes.ok) throw new Error(`debug token ${tokRes.status}`);
    const { ws_url } = (await tokRes.json()) as { ws_url: string };

    const res = await fetch(ws_url, { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) throw new Error(`no websocket in upgrade response (${res.status})`);
    ws.accept();

    ws.addEventListener("message", (ev) => {
      void this.onFrame(String(ev.data));
    });
    ws.addEventListener("close", () => {
      this.ws = null;
    });
    ws.addEventListener("error", () => {
      this.ws = null;
    });

    this.ws = ws;
    this.connectedAt = Date.now();
  }

  /** Demux one VB frame to its CallDO. */
  private async onFrame(raw: string) {
    let f: VBFrame;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (f.type !== "debug_event" || !f.session_id) return;

    // session_id IS the room_name -- verified live, this is the whole join.
    const dispatchId = this.route(f.session_id);
    if (!dispatchId) return; // event for a call we did not start

    const stub = this.env.CALL.getByName(dispatchId);
    await stub.append(f.event_type ?? "unknown", f.data ?? {}, f.timestamp);

    if (f.event_type === "session_started") await stub.setStatus("IN_CALL");
    if (f.event_type === "session_ended") await stub.setStatus("RESOLVING");
  }

  /**
   * Watchdog. Idempotent by construction: reconnect only when the socket is
   * missing or old. Alarms do not repeat, so re-arm every time.
   */
  async alarm() {
    const open = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM routes")
      .one().n;
    if (open === 0) return; // nothing in flight: let the object go idle
    await this.ensureConnected();
  }
}

/* ------------------------------------------------------------------ Worker */

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Dashboard read. Employee-spined, all 26 — /api/dispatches cannot render
    // this because a GREEN employee has no dispatch row.
    if (url.pathname === "/api/roster" && req.method === "GET") {
      const eventId = url.searchParams.get("event_id") ?? "evt-busan";
      return getRoster(env, eventId);
    }

    // Terminal write: execute pending work and close the impact out. Without
    // this nothing ever reaches RESOLVED and every booked card reads "Booking"
    // forever. Not dev-gated — this is the real executor seam, simulated in v1.
    if (url.pathname === "/api/actions/drain" && req.method === "POST") {
      return drainActions(env, new Date());
    }

    // Close an approval. The ONLY thing in the codebase that can — the voice
    // agent opens the gate and never closes it.
    if (url.pathname.startsWith("/api/approval/") && url.pathname.endsWith("/decide")) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const approvalId = url.pathname.split("/")[3];
      const body = (await req.json().catch(() => ({}))) as {
        decision?: Decision;
        offerId?: string | null;
        note?: string | null;
      };
      if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
        return Response.json({ error: "decision must be APPROVED or REJECTED" }, { status: 400 });
      }
      try {
        const result = await decideApproval(
          env,
          {
            approvalId,
            decision: body.decision,
            offerId: body.offerId ?? null,
            note: body.note ?? null,
            // Server-side, deliberately. A browser-supplied decided_by is fake
            // accountability — this row is the audit trail for a real charge.
            // v1 has no auth layer, so it is a constant rather than a session.
            decidedBy: OPERATOR_ID,
          },
          new Date(),
        );
        return Response.json({ ok: true, ...result });
      } catch (err) {
        if (err instanceof TransitionError) {
          return Response.json({ error: err.message, code: err.code }, { status: err.status });
        }
        throw err;
      }
    }

    // Demo seams. Gated: a test seam that ships is how demos get embarrassing.
    if (url.pathname.startsWith("/api/dev/")) {
      if (env.ENABLE_DEV_ROUTES !== "true") {
        return new Response("dev routes disabled", { status: 404 });
      }
      if (url.pathname === "/api/dev/disrupt" && req.method === "POST") {
        return disrupt(env, new Date());
      }
      if (url.pathname === "/api/dev/call" && req.method === "POST") {
        return placeCall(env, await req.json().catch(() => ({})), new Date());
      }
      if (url.pathname === "/api/dev/call/release" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { slot?: string };
        return releaseCall(env, b.slot ?? "slot-a");
      }
      if (url.pathname === "/api/dev/reset" && req.method === "POST") {
        return reset(env);
      }

      // Simulated travellers. Only emp-us-01 is on a real call; the other three
      // are walked through DIALING -> IN_CALL -> RESOLVING -> RESOLVED with
      // captured VB frames replayed into their CallDOs, so the board moves
      // instead of sitting still while one phone rings. Writes D1 and CallDO
      // only — it cannot dial. See dev-replay.ts.
      if (url.pathname === "/api/dev/replay" && req.method === "POST") {
        // ?sync=1 blocks until the timeline finishes. The demo does NOT use it:
        // the walk runs under waitUntil so the button returns immediately.
        // ?speed=N compresses the ~74s timeline by N, for rehearsal.
        const sync = url.searchParams.get("sync") === "1";
        const speed = Number(url.searchParams.get("speed") ?? "1");
        return replay(env, ctx, { sync, speed });
      }
      if (url.pathname === "/api/dev/replay/reset" && req.method === "POST") {
        return replayReset(env);
      }
    }

    // Agent screen: live event stream for one dispatch.
    if (url.pathname.startsWith("/api/dispatch/") && url.pathname.endsWith("/stream")) {
      const id = url.pathname.split("/")[3];
      return env.CALL.getByName(id).fetch(req);
    }

    // Dashboard: status only, no streaming.
    if (url.pathname.startsWith("/api/dispatch/")) {
      const id = url.pathname.split("/")[3];
      return Response.json(await env.CALL.getByName(id).getStatus());
    }

    // Test seam: inject a frame exactly as VB would send it.
    if (url.pathname === "/api/test/emit" && req.method === "POST") {
      const body = (await req.json()) as {
        dispatchId: string;
        kind: string;
        payload: unknown;
      };
      const seq = await env.CALL.getByName(body.dispatchId).append(body.kind, body.payload);
      return Response.json({ seq });
    }

    if (url.pathname === "/api/test/init" && req.method === "POST") {
      const b = (await req.json()) as { dispatchId: string; employeeId: string; directive: string };
      await env.CALL.getByName(b.dispatchId).init(b.dispatchId, b.employeeId, b.directive);
      return Response.json({ ok: true });
    }

    return new Response("chingu dispatch worker", { status: 200 });
  },

  /** Fan-out consumer. Concurrency is capped in wrangler.jsonc, not here. */
  async queue(batch: MessageBatch<DispatchJob>, env: Env) {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        const call = env.CALL.getByName(job.dispatchId);
        await call.init(job.dispatchId, job.employeeId, job.directive);

        // Deny-by-default before anything reaches the PSTN. seed.sql ships 16
        // Korean numbers in a NON-reserved range; a fan-out against seed data
        // would phone real strangers. Checked before setStatus("DIALING") so a
        // refused dispatch never claims to have dialed.
        assertDialable(job.phone, env);

        await advance(env, job.dispatchId, "DIALING");

        const res = await fetch(`${VB_BASE}/api/v1/calls`, {
          method: "POST",
          headers: {
            "X-API-Key": env.VB_API_KEY,
            "X-Agent-Id": env.VB_AGENT_ID,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            phone_number: job.phone,
            participant_name: job.employeeId,
          }),
        });
        if (!res.ok) throw new Error(`calls ${res.status}: ${await res.text()}`);

        // No session_id here -- only room_name. That is the join key.
        const { room_name } = (await res.json()) as { room_name: string };
        await env.DB.prepare(`UPDATE dispatch SET room_name = ? WHERE id = ?`)
          .bind(room_name, job.dispatchId)
          .run();
        await advance(env, job.dispatchId, "IN_CALL");
        await env.INGEST.getByName("singleton").bind(room_name, job.dispatchId);

        msg.ack();
      } catch (err) {
        await env.CALL.getByName(job.dispatchId).append("error", {
          message: String(err),
          attempt: msg.attempts,
        });

        // An allowlist refusal is a permanent decision, not a transient fault.
        // Retrying it would burn the DLQ budget re-deciding the same "no", and
        // three more attempts is three more chances to get the guard wrong.
        if (err instanceof NotAllowlisted) {
          await advance(env, job.dispatchId, "FAILED");
          msg.ack();
          continue;
        }

        msg.retry({ delaySeconds: 5 * msg.attempts });
      }
    }
  },
};
