# Chingu — Session Handoff

Context transfer for planning API → frontend/backend work.
Format: **lesson** : where the detail lives.

Everything below was verified live unless marked otherwise. The append-only logs
are the source of truth; this file is an index, not a replacement.

---

## Voice layer (VocalBridge)

**`session_id` in a debug event IS the `room_name` — correlation is string equality, no lookup** : `VOCALBRIDGE_LEARNINGS.md:14`
**Debug stream is agent-scoped — but the slot pool means N agents, so IngestDO holds N sockets and demuxes on `(agent_id, session_id)`** : `VOCALBRIDGE_LEARNINGS.md:9`, `:21`, `:22`
**Debug event envelope + every payload shape the agent screen needs** : `VOCALBRIDGE_LEARNINGS.md:15`
**`session_ended` is UNRELIABLE, not absent (fired 6/8) — post-processing MCP is still the only terminal write; treat `session_ended` as a fast-path hint only** : `VOCALBRIDGE_LEARNINGS.md:23` (corrects `:15`)

## Agent correlation (settled — this overrides earlier assumptions)

**VB sends NO per-call context to tool endpoints and has NO dial-time injection channel** : `VOCALBRIDGE_LEARNINGS.md:19`
**The LLM corrupts any value it is asked to carry — 0-for-4 on an id, 0-for-3 on a year. Never pass it an identifier** : `VOCALBRIDGE_LEARNINGS.md:20`
**Correlation lives in the tool URL path: `/tools/:slot/*`, one dispatch per agent, resolved server-side from `agent_slot`** : `VOCALBRIDGE_LEARNINGS.md:21`, verified `:22`
**VB drops undeclared arguments before egress — a zero-parameter tool is zero-parameter by construction, not by prompt discipline** : `VOCALBRIDGE_LEARNINGS.md:23`
**Concurrency is capped by POOL SIZE, not by queue `max_concurrency`** : `VOCALBRIDGE_LEARNINGS.md:21`
**`auth.type: bearer` verified 14/14 — mandatory, since slot paths are guessable and reissue tickets** : `VOCALBRIDGE_LEARNINGS.md:22`
**`session_started` can fire twice — handler must be idempotent** : `VOCALBRIDGE_LEARNINGS.md:15`
**VB parallelizes: 3 concurrent sessions on one agent, proven** : `VOCALBRIDGE_LEARNINGS.md:16`
**`api_tools` JSON schema (undocumented `id` field is required)** : `VOCALBRIDGE_LEARNINGS.md:17`
**Transcripts persist server-side but pull-only — no webhook** : `VOCALBRIDGE_LEARNINGS.md:7`
**Client Actions are participant-scoped → useless for the dispatcher dashboard** : `VOCALBRIDGE_LEARNINGS.md:8`
**Outbound PSTN gates; `deploy_targets:"both"` needs a provisioned number, not just a paid plan** : `VOCALBRIDGE_LEARNINGS.md:11`, `:17`
**API 403s the default `Python-urllib` User-Agent** : `VOCALBRIDGE_LEARNINGS.md:17`

## Infrastructure (Cloudflare)

**IngestDO/CallDO topology + the five rules it rests on** : `VOCALBRIDGE_LEARNINGS.md:10`
**Outbound WS keeps a DO alive only 15 min → alarm watchdog is load-bearing** : `VOCALBRIDGE_LEARNINGS.md:13`
**Use SQLite-backed DOs; `seq` = `INTEGER PRIMARY KEY AUTOINCREMENT`, never a timestamp** : `VOCALBRIDGE_LEARNINGS.md:13`
**Deploying disconnects every WS and restarts every DO — never push during the demo** : `VOCALBRIDGE_LEARNINGS.md:13`
**Queue fan-out; `max_concurrency` is the single knob** : `VOCALBRIDGE_LEARNINGS.md:12`
**DO flow validated locally against real captured events (SSE replay, cursor resume, ordering)** : `VOCALBRIDGE_LEARNINGS.md:18`

## Data layer (Sabre)

**Flight rebooking works end-to-end; `CASH` unblocks ticketing with no card** : `SABRE_LEARNINGS.md:12`
**Change fees are visible at *search* time — rebooking economics need no ticket/PNR/card** : `SABRE_LEARNINGS.md:10`, `:13`
**Hotel booking SOLVED — test Visa `4111111111111111` works in CERT; nothing is ever charged** : `SABRE_LEARNINGS.md:20` (supersedes the "hard blocker" at `:18`)
**Booking response hands you the property's phone number — that is what the voice agent dials, no lookup** : `SABRE_LEARNINGS.md:21`
**`refundPenalties[]` is an explicit date-ranged cancellation ladder** : `SABRE_LEARNINGS.md:21`
**NO list/search endpoint — `get-booking` takes a confirmationId and nothing else. Our DB is an index + workflow state, not a travel database** : `SABRE_LEARNINGS.md:22`
**Two locators per booking: Sabre PNR vs airline locator — quote the airline's to the airline** : `SABRE_LEARNINGS.md:22`
**`bookingSignature` + `numberOfUpdates` give optimistic concurrency — store last-seen to detect drift** : `SABRE_LEARNINGS.md:22`
**`modify-booking` serializes per PNR → parallelize across employees, never within one booking** : `SABRE_LEARNINGS.md:17`
**Reshop/hotel-rates responses are ~170KB — must be filtered before anything reads them** : `SABRE_LEARNINGS.md:13`, `:14`
**Offers expire: flight 20 min, hotel `bookingKey` ~7 min** : `SABRE_LEARNINGS.md:19`
**Everything stays in CERT. Never book production; never send a fabricated PAN to prod** : `HACKATHON_CONTEXT.md:79`, `SABRE_LEARNINGS.md:20`

## Tooling

**`grep`/`sed` redirection is rewritten by the rtk hook and destroys files — use the Edit tool** : `SABRE_LEARNINGS.md:23`
**`npx` is rewritten to `npm run` — call binaries at `./node_modules/.bin/`** : this session
**Account API key needs `X-Agent-Id`; `vb --agent` is not accepted — curl directly or `vb agent use`** : this session

---

## Data model

> **SUPERSEDED — the contract is now `worker/schema.sql`**, with `worker/seed.sql`
> as the 26-employee demo fixture (validated, idempotent). `DATA_MODEL.md`
> explains the reasoning. The sketch below is kept only for provenance; it
> predates policy, approvals, offers, slot leasing, and the `dispatch`/impact
> split. **Do not build from it.**

D1 holds everything relational. Events do **not** go in D1 — they live in each
CallDO's own SQLite and only the summary lands in D1 on close.

**D1 is an index + workflow state, not a travel database** (`SABRE_LEARNINGS.md:22`).
Sabre is the system of record for itinerary content but has no list/search
endpoint, so we store only what lets us *find* a booking and what Sabre does not
model at all: employee↔PNR mapping, the event, triage state, call state, policy.
Do not mirror segments-as-truth, fare construction, taxes, baggage or SSRs —
fetch those from `get-booking` on demand.

```sql
employee    id · name · email · phone_e164 · home_base · status
              -- status: OK | AT_RISK | DELAYED | RESOLVED

itinerary   id · employee_id · pnr · airline_locator · ticket_number
              · booking_signature · num_updates · status
              -- two locators: pnr is Sabre's, airline_locator is what you
              --   quote to the carrier. booking_signature detects drift.

segment     id · itinerary_id · carrier · flight_no · dep_airport
              · arr_airport · dep_time_utc · status
              -- denormalised ONLY so triage is a real WHERE. Truth is Sabre.

hotel_stay  id · employee_id · pnr · item_id · confirmation_id
              · product_code · supplier_rate_code · property_phone
              · check_in · check_out · free_cancel_until
              -- property_phone is what the voice agent dials
              -- product_code + supplier_rate_code are required by modify-booking

disruption  id · kind · carrier · flight_no · date · detected_at

dispatch    id · disruption_id · employee_id · directive
              · status · created_at · resolved_at
              · call_id · room_name · session_id
              · outcome_summary
```

**`dispatch` is the spine.** It exists at `QUEUED` before VB knows anything,
gets `call_id`/`room_name` when the consumer fires, and `room_name` is the join
key to the live event stream. CallDO is named by `dispatch_id` (not session), so
the agent screen is openable the moment work is enqueued.

Lifecycle: `QUEUED → DIALING → IN_CALL → RESOLVING → RESOLVED | FAILED | NO_ANSWER`

Since `session_ended` never fires, `RESOLVING → RESOLVED` **must** be driven by
the post-processing MCP callback. Nothing else closes a dispatch.

### CallDO-local (per dispatch, SQLite)

```sql
events  seq INTEGER PRIMARY KEY AUTOINCREMENT · kind · payload · vb_ts · created_at
meta    k · v   -- dispatch_id, employee_id, directive, status, room_name
```

`vb_ts` is display-only. Ordering is always `seq`.

---

## Current state

| Path | State |
|---|---|
| `worker/` | IngestDO + CallDO + queue consumer. Runs under `wrangler dev`, validated locally. Not deployed. |
| `worker/src/index.ts` | All logic. Test seams at `/api/test/init` and `/api/test/emit`. |
| `frontend/` | Bare Next.js skeleton. **Has its own nested `.git`** — untangle before committing. |
| repo root | Nothing tracked yet; no commits. |

**No VB agents currently exist — the account is empty (verified 2026-07-18T19:1xZ).**
All prior agents were deleted deliberately: the `Chingu Dispatch` pair (one an
orphan from a failed `deploy_targets: both` create) and the pre-existing
`Test Agent`. Any agent ID appearing in `VOCALBRIDGE_LEARNINGS.md` is historical
and **will 404** — the learnings themselves still hold, only the IDs are dead.

The slot pool is created fresh from `worker/` config. When you create them, record
the new IDs here and in `worker/.dev.vars` (`VB_AGENT_ID`, currently a placeholder).
Note the 5-agent cap, and that **a failed create still consumes a slot** — list and
prune before creating a pool.

## Two read paths (deliberately different)

- **Dashboard** — polls D1 for `dispatch.status`. No streaming.
- **Agent screen** — SSE against one CallDO. `Last-Event-ID` gives history replay
  plus live tail, so opening mid-call shows the whole conversation.

## Open items

1. **Outbound ToS** — needs a human to accept: `vb config set --outbound-enabled true --accept-outbound-tos`
2. **Phone number provisioning** — appears dashboard-only, no CLI flag
3. **A destination number** for the one unproven hop (real PSTN dispatch)
4. **`wrangler login`** — needed to deploy; local dev works without it
5. **Frontend hosting** — Worker-served (one deploy) vs Vercel (adds CORS on the SSE path)
6. Swap httpbin tool URLs for the real Worker endpoints
