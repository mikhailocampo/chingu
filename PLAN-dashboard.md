# Plan — Chingu Dashboard, Screen 1 (Employees)

## Goal

One screen. A people-ops coordinator (Hyejin Cho at Samsung) opens it during the
Busan offsite and sees, at a glance, which of her 26 travellers are fine and which
are not — and can act on the ones that aren't.

Reference sketch: a roster of employee cards. Each card carries a name, a status
(GREEN / AT RISK / CALLING / RESOLVED), an advisory line when the agent has a
recommendation, and a chevron into detail. Below the roster, a voice/mic
affordance for spoken approval ("Approved to fix John's risk using company
policy ABC").

Card lifecycle in the sketch:
GREEN → AT RISK (advised: fix flight by X with policy Y) → CALLING → GREEN (resolved)

## What exists today

### frontend/
Bare Vite + React 19 scaffold. Not Next.js (HANDOFF.md says Next — it is wrong).

- Build: Vite 8, TypeScript 6, Bun lockfile
- Styling: Tailwind v4 via `@tailwindcss/vite`, CSS-first config in `src/index.css`
  (`@theme inline`, oklch tokens, light + `.dark` blocks already defined)
- shadcn: style `base-rhea`, built on `@base-ui/react` (NOT Radix). Registry
  configured in `components.json`, aliases `@/components`, `@/lib`, `@/components/ui`
- Installed primitives: **`button.tsx` only**. Everything else must be added.
- Fonts: Roboto Variable (sans), Montserrat Variable (heading) — already imported
- Icons: lucide-react
- `theme-provider.tsx` exists (press `d` to toggle dark)
- No router, no data layer, no test setup

### worker/
- `schema.sql` — the executable contract (16 tables)
- `seed.sql` — verified applied locally, 211 lines
- `src/index.ts` — CallDO + IngestDO + queue consumer. HTTP surface today is
  only `/api/dispatch/:id`, `/api/dispatch/:id/stream` (SSE), and two test seams.
  **There is no employee/roster read API yet.**

### backend/workers/tools/
Concurrent work. `get_brief.ts` is the voice agent's read model — a useful
precedent for the shape of a case packet.

## Verified seed state (queried, not assumed)

| table | rows |
|---|---|
| employee | 26 |
| itinerary | 34 |
| segment | 34 |
| policy | 3 |
| activity | 1 (the dinner) |
| attendance | 26 |
| agent_slot | 3 |
| **disruption_event** | **0** |
| **disruption_impact** | **0** |
| **offer** | **0** |
| **dispatch** | **0** |
| **approval** | **0** |

Two employees are `AT_RISK` at seed time:
- `emp-us-07` Grace Lombardi — UA805 lands 19:20Z 15 Sep, past `event.arrival_by`
- `emp-us-10` Nora Feldman — no itinerary at all

Codeshare triage verified working: querying KE82 on 14 Sep returns 4 people,
including Elena Duarte on marketing DL7842.

**Consequence for this screen:** with the seed alone, 24 cards are GREEN and 2 are
AT RISK with no advisory text, because advisories come from `offer` rows that do
not exist. CALLING comes from `dispatch`, also empty. The lifecycle in the sketch
is not reachable from seed data.

## Data access — how the frontend reads D1

D1 has no client SDK. A browser cannot query it. Reads go through a Worker.

### Backend contract (supplied by the worker track, 2026-07-18)

Module split: `index.ts` router only, `call-do.ts`, `ingest.ts`, `dispatch.ts`
(these routes), `tools.ts` (voice agent tools).

| Route | Source | Purpose |
|---|---|---|
| `GET /api/dispatches?event_id=` | D1 | dashboard list |
| `GET /api/dispatch/:id` | D1 | detail + status |
| `GET /api/dispatch/:id/stream` | CallDO | agent screen SSE |
| `POST /api/dev/dispatch` | D1 + CallDO | seed a fake dispatch |

```jsonc
// GET /api/dispatches?event_id=evt-busan
{ "dispatches": [{
    "id": "dsp_01",
    "kind": "CALL_EMPLOYEE",
    "status": "IN_CALL",   // QUEUED|DIALING|IN_CALL|RESOLVING|RESOLVED|FAILED|NO_ANSWER
    "employee": { "id": "emp-us-02", "name": "Priya Natarajan", "home_base": "New York" },
    "directive": "KE82 cancelled — offer 3 options",
    "slot": "slot-a",
    "created_at": "...", "resolved_at": null, "outcome_summary": null
}] }
```

Backend decisions taken: status is read from D1 not CallDO (one writer, one
truth); CallDO is named by `dispatch_id` so the stream is openable at QUEUED;
CORS `*` on the stream route; `/api/dev/*` gated on an env flag.

SSE resume is proven — reconnect sends `Last-Event-ID`, the DO replays `seq >
cursor` then goes live. Ordering is `seq`, never `vb_ts`.

**Frontend answer to their Q1:** joined, yes. The card needs `name` and
`home_base` at render time; a second fetch would mean 26 cards rendering nameless.

### GAP — dispatch-centric vs employee-centric (for eng review)

`/api/dispatches` returns rows only for people the agent is *acting on*. A GREEN
employee has no dispatch, no impact, no offer, and therefore no row. The roster
in the sketch shows all 26. **These are two different reads and the contract only
covers one of them.**

Still needed:

```
GET /api/roster?event_id=evt-busan   -> all 26, employee-spine, dispatch overlaid
GET /api/employee/:id                -> detail drawer
```

`/api/roster` is one query with joins, not N+1 (one query per row — the pattern
that turns a 26-row list into 27 database round trips). `/api/dispatches` then
becomes the *live activity* feed, not the roster source.

### Admin: creating a disruption

Separate screen, out of scope for screen 1 but in scope for the build. Lets an
operator fire `KE82 cancelled on 2026-09-14` and watch the roster react. This is
what makes the sketch's lifecycle reachable — see "Verified seed state" above.

Roster row shape:

```ts
type RosterRow = {
  employeeId: string
  name: string
  homeBase: string | null
  status: 'OK' | 'AT_RISK' | 'DELAYED' | 'RESOLVED'
  impactState: 'DETECTED'|'TRIAGING'|'AWAITING_APPROVAL'|'CONTACTING'|'RESOLVED'|'FAILED' | null
  dispatchStatus: 'QUEUED'|'DIALING'|'IN_CALL'|'RESOLVING'|'RESOLVED'|'FAILED'|'NO_ANSWER' | null
  advisory: string | null      // top-ranked offer route_summary + policy verdict
  policyVerdict: 'PASS'|'NEEDS_APPROVAL'|'FAIL' | null
  totalDelta: string | null    // decimal string, never a float
  segments: { carrier, flightNo, origin, dest, arrTimeUtc }[]
}
```

The card status shown to the user is **derived**, not a single column:

```
dispatch.status IN (DIALING, IN_CALL)          -> CALLING
impact.state = AWAITING_APPROVAL               -> NEEDS YOU
impact.state IN (DETECTED, TRIAGING)           -> AT RISK
employee.status = AT_RISK                      -> AT RISK
impact.state = RESOLVED / employee = RESOLVED  -> RESOLVED
otherwise                                      -> GREEN
```

Frontend fetching: plain `fetch` in a small `useRoster()` hook with a poll
interval. Vite dev proxy to `localhost:8787` so no CORS in dev.

## Build order

1. Worker read endpoints + typed row shape (shared types file)
2. shadcn primitives needed: card, badge, skeleton, scroll-area, separator,
   dialog/drawer, input
3. `useRoster()` hook — fetch + poll
4. `EmployeeCard` + status pill
5. Roster grid + header summary
6. Detail drawer
7. Mic / approval affordance
8. A `POST /api/dev/disrupt` seam so the lifecycle is demoable

## Decisions taken (Step 0D)

1. **Full 7-pass design review.** Nothing deferred into implementation.
2. **Dev disrupt seam gets built.** `POST /api/dev/disrupt` cancels KE82 on
   2026-09-14, writing one `disruption_event`, 4 `disruption_impact` rows (the
   three marketing-KE82 travellers plus Elena Duarte on DL7842), and the three
   real priced offers from `HACKATHON_CONTEXT.md:59-61`:

   | Option | Fare | Change fee | Verdict |
   |---|---|---|---|
   | OZ223 JFK 01:30 → ICN 06:05+1 | $1,071.40 | $120 | PASS |
   | CX841+CX416 via HKG | $559.30 | $200 | NEEDS_APPROVAL |
   | UA805 SFO basic economy | $338.50 | $299 | NEEDS_APPROVAL |

   Surfaced through an **admin page**, not a curl command, so the disruption is
   demoable on stage. This is also what makes the sketch's lifecycle renderable.
3. **Mic is push-to-talk with a confirm step.** Speech transcribes and pre-fills
   the approval; the coordinator taps to confirm before an `approval` row writes.
   A misheard word must not authorize a $400 add-collect.

---

# Design specification (from /plan-design-review)

Approved mockup: `~/.gstack/projects/mikhailocampo-chingu/designs/dashboard-roster-20260718/wireframe-a.html`

## Information architecture — triage spine, not a roster

The screen is NOT 26 equal cards. Urgency buys size. Four bands, in order:

```
  Employees                                    Synced 14s ago
  Samsung Global Offsite · Busan · 15–18 Sep 2026
  ┌──────┬──────────┬─────────┬───────────┬──────────┐
  │  26  │    2     │    4    │     1     │  $1,159  │   ← every stat is a filter
  │ trav │ NEED YOU │ at risk │ on a call │ exposure │
  └──────┴──────────┴─────────┴───────────┴──────────┘

  WAITING ON YOU ─────────────────────────────────  2   ← large cards, actions inline
  AGENT WORKING ──────────────────────────────────  3   ← large cards, live transcript
  RESOLVED TODAY ─────────────────────────────────  1   ← large cards, receipt tone
  ON TRACK ───────────────────────────────────────  20  ← compact table, NOT cards
```

A stat that cannot be clicked to filter gets cut. That is what keeps the summary
strip from being a dashboard-card mosaic.

The 20 on-track people are a `<table>`, 9px row padding, low contrast, with
`Show 14 more`. Cards must earn their existence; "is fine" does not earn one.

## Card content, in priority order

1. Name (Montserrat 600, 17px) + status pill + home base
2. **Advisory in plain English.** "Was on DL7842 — the same aircraft as cancelled
   KE82" beats any rendering of a join key. This line is the product.
3. Meta row: PNR, policy id + version + verdict, option count
4. Actions, right-aligned. Chevron to detail.

## Status derivation (unchanged, still correct)

```
dispatch.status IN (DIALING, IN_CALL)          -> CALLING
impact.state = AWAITING_APPROVAL               -> NEEDS YOU
impact.state IN (DETECTED, TRIAGING)           -> AT RISK
employee.status = AT_RISK                      -> AT RISK
impact.state = RESOLVED / employee = RESOLVED  -> RESOLVED
otherwise                                      -> GREEN
```

## Interaction states — all specified

| Surface | Loading | Empty | Error | Partial |
|---|---|---|---|---|
| Roster | 4 skeleton cards + quiet rows; counts dashed, not `0` | see **calm state** below | "Can't reach dispatch. Showing data from 19:41." Banner + dimmed cards. **Never blank** | — |
| Advisory | "Pricing alternatives…" | "No alternatives found. Call them anyway." | "Search failed, retrying (2/3)" | "2 of 3 searches back" — show what exists |
| Live call | "Connecting to slot-a…" | — | "Stream dropped. Reconnecting…" keep last transcript | mid-sentence, never blank |
| Voice approval | waveform | "Didn't catch that" | "No match for 'Elena'" + name picker | low-confidence words underlined |

### Calm state — DECIDED: "show the watch"

The default state is 26 green people and nothing to do. It must read as
*actively monitoring*, not idle:

- Last sync + next departure countdown
- The two people structurally at risk with no disruption at all:
  Grace Lombardi (lands past `event.arrival_by`) and Nora Feldman (no itinerary)
- Therefore the screen is **never** truly empty. There is always something.

A grey page reading "All 26 on track" is a failure. The product's whole claim is
that it is watching.

## Live updates — DECIDED: poll + per-call SSE

- Roster: `GET /api/roster` poll every 5s. Status is authoritative in D1.
- Live transcript: existing proven SSE (`/api/dispatch/:id/stream`) only when a
  call card is expanded. `Last-Event-ID` resume already works.
- Rationale: one stalled poll cannot kill the transcript, and no new D1-change
  broadcast path is needed.

## Approval depth — DECIDED: card approves only when unambiguous

- **Single clear best option** (Priya: OZ223, in policy, agent may act alone)
  → one-click approve on the card.
- **Real tradeoff** (Grace: no option is both in-policy and on time)
  → card action opens the detail view. No one-click path.
- Every approval writes `approval` with `decided_by`, and the card shows the
  policy id + version it was judged against. `decision = MODIFIED` when she picks
  a different offer — per `DATA_MODEL.md:154`, the most interesting row in the table.

## Voice approval — push-to-talk, confirm required

**REVISED after reading `VOCALBRIDGE_LEARNINGS.md:8`.** This is not a
speak-a-command-and-parse-it flow. It is a live conversation with a **dedicated
dispatcher VB agent**, and approvals arrive over VB's Client Actions data channel.

### Why Client Actions are valid here (and where the notes say they aren't)

`VOCALBRIDGE_LEARNINGS.md:8` concludes Client Actions are "participant-scoped and
therefore useless for the Dispatch dashboard." That verdict was about the
**employee-calling** agent: the client in the room is the employee's browser, or
on PSTN nothing at all, so it can never reach the dispatcher.

The dispatcher agent inverts it. **The dispatcher is the participant, in her own
browser** — the one case line 8 explicitly carves out as legitimate. Architecture
holds. Two caveats from that same row survive and are load-bearing.

### Caveat 1 — the channel has no history or replay

> "navigate away → peer connection tears down → anything published while
> disconnected is lost forever"

**Therefore: D1 is truth, the client action is only a nudge.** The `approval` row
(`requested_at` set, `decided_at` null) is what makes a card read "Needs you".
The voice channel is a faster path to that same row, never a separate one. If the
session drops mid-approval the card still holds it, unchanged.

### Caveat 2 — leaving the page removes a participant from a live call

**Therefore: the detail view MUST NOT be a route change.** Every roster chevron
opens a drawer/sheet over the same page. Navigating to read Elena's three options
would otherwise hang up on the agent mid-sentence.

### State machine — two independent layers

```
SESSION (the connection)
  OFFLINE ──click mic──▶ CONNECTING ──▶ LIVE ──click stop──▶ OFFLINE
                                          │
                                          └─ drops → OFFLINE + toast;
                                             pending approvals survive in D1

APPROVAL (per request; rides the session, does not depend on it)
  agent calls trigger_client_action
        │
        ▼
  approval-requested ──Approve/Reject──▶ approval-responded ──▶ output-available
        │                                        │
        │                                    browser replies, behavior: "respond"
        └─ session dies here → card stays in "Waiting on you", sourced from D1
```

### Components — reuse, do not hand-roll

| Need | Component | Notes |
|---|---|---|
| Listening state | `@ai-elements/speech-input` | Ships the ping rings, `bg-destructive` while listening, spinner while processing, mic↔square swap. Web Speech API with MediaRecorder fallback (Firefox/Safari). **Click-to-toggle, not push-to-hold** — correct for a conversation. Earlier "hold Space" model dropped. Pulls `button` + `spinner`. |
| Approval card | `@ai-elements/confirmation` | States are literally `approval-requested` / `approval-responded` / `output-available` / `output-denied`, with `ConfirmationRequest` / `Accepted` / `Rejected` / `Actions` slots. Pulls `alert` + `button`. Imports `ToolUIPart` from `ai` **as a type only** — type it locally instead of taking the dependency. |
| Transcript | `@ai-elements/conversation`, `@ai-elements/message` | It is a dialogue now, not a one-shot command. |
| Device picker | `@ai-elements/mic-selector` | Optional. |

Approval copy still states the match in full: "Elena Duarte → CX841 via HKG,
+$200, pol-flight v1. Nothing is booked until you confirm." A misheard word must
never authorize a $400 add-collect.

## Theme — DECIDED: light-first, maximum reuse of what exists

Light mode is primary. The screen is built on the `:root` block already in
`index.css` — `--background`, `--card`, `--muted`, `--border`,
`--muted-foreground`, `--primary`, `--destructive`, `--radius` all used as-is.
Dark stays available via `theme-provider.tsx` but is not the design target.

`index.css` has no *status* colors, and the five chart colors are the wrong pool
(all blue, they encode series not severity). Only four tokens get added, and two
are aliases of what you already have:

```css
--status-ok:      oklch(0.52 0.15 155);       /* green, tuned for white  */
--status-risk:    oklch(0.52 0.13 65);        /* amber, darkened for AA  */
--status-calling: oklch(0.5 0.134 242.749);   /* == --primary           */
--status-needs:   oklch(0.577 0.245 27.325);  /* == --destructive       */
```

Register through `@theme inline` like every existing token so `text-status-risk`
works. Dark-mode variants of these four are the one open theming task.

Radius by element class, not uniform: cards `--radius-lg`, pills `999px`, quiet
table square internally. Uniform radius everywhere is on the AI-slop list.

Radius by element class, not uniform: cards `--radius-lg`, pills `999px`, quiet
table square internally. Uniform radius everywhere is on the AI-slop list.

## Components to add (shadcn `base-rhea`, **@base-ui/react — NOT Radix**)

`card`, `badge`, `skeleton`, `table`, `separator`, `drawer`, `tooltip`, `collapsible`.
Do not paste Radix-based snippets; this registry is base-ui.

## Responsive

| | 1440 | 768 | 375 |
|---|---|---|---|
| Summary | 5 across | 3 across | 2 across, exposure dropped |
| Card | actions right-aligned | actions right | actions below advisory, full-width |
| Quiet table | name / base / status | name / status | name / status, base dropped |
| Voice dock | fixed bar | fixed bar | FAB, expands to sheet |

Not "stacked on mobile" — different information at each width.

## Accessibility

- `aria-live="polite"` on the live transcript and on the summary counts. Without
  it a screen-reader user gets nothing from a call and the roster mutates silently.
- Touch targets 44px minimum. The mockup's 31px `Approve` fails and must grow.
- Push-to-talk needs a keyboard equivalent and must never be the only approval path.
- Metadata line 13px floor; body text stays ≥16px equivalent.
- `--muted-foreground` on `--background` measures ~6.4:1 — passes AA, keep it.
- Status is never color-only: every pill carries a text label.

## Admin — disruption trigger — DECIDED: simple scenario picker

Separate route. Three named buttons matching the three scenarios in
`HACKATHON_CONTEXT.md`, plus a reset:

```
  Cancel KE82 · 14 Sep        → 1 disruption_event, 4 impacts, 3 priced offers
  Shift offsite dates         → hotel modifications
  Dinner venue problem        → the 26-way fan-out
  ─────────────────────────
  Reset to seed
```

Same tokens and typography as the dashboard, no new visual vocabulary, no
free-text fields. Deliberate enough to show on stage, cheap enough not to compete
with the roster for build time. Gated behind the `/api/dev/*` env flag.

---

## NOT in scope (deliberately deferred)

- **Detail drawer's full design.** Screen 1 is the roster. The drawer is
  specified only far enough to know approvals land there.
- **Hotel and dinner scenarios on this screen.** Flight disruption drives the
  card lifecycle; scenarios 2 and 3 reuse the same bands.
- **Multi-event switching.** One org, one offsite, hardcoded `evt-busan`.
- **Auth / operator login.** `operator` exists in schema, no session layer yet.
- **Light mode.** Tokens exist for it; the crisis dashboard is designed dark-first
  and light is untested.
- **Dietary / attendance surface.** Priya's shellfish allergy is scenario 3.

## What already exists (reuse, don't rebuild)

| Asset | Where | Use |
|---|---|---|
| oklch token system, light + dark | `frontend/src/index.css` | extend with status colors |
| Montserrat + Roboto, imported | `frontend/src/index.css` | headings / body, no new fonts |
| `theme-provider.tsx` | `frontend/src/components/` | as-is |
| `button.tsx` (base-rhea) | `frontend/src/components/ui/` | all card actions |
| Case-packet read model | `backend/workers/tools/src/brief.ts` | mirror its joins for `/api/roster` |
| SSE + `Last-Event-ID` resume | `worker/src/index.ts` CallDO | live transcript, proven |
| Verified codeshare triage | `worker/seed.sql` + schema indexes | Elena Duarte's advisory line |

## Approved mockups

| Screen | Path | Direction |
|---|---|---|
| Employees (light — **build from this**) | `~/.gstack/projects/mikhailocampo-chingu/designs/dashboard-roster-20260718/wireframe-light.html` | Light-first on existing `:root` tokens. Triage spine, four bands, collapsed voice dock with all three states shown. |
| Employees (dark — reference) | `~/.gstack/projects/mikhailocampo-chingu/designs/dashboard-roster-20260718/wireframe-a.html` | Same IA, dark. Kept for when dark-mode status tokens get tuned. |

Both populated with real seed people and the real priced offers, not placeholders.

## Deferred (TODOS.md)

1. **Dark-mode status tokens.** The four status colors are tuned for white.
   `theme-provider.tsx` toggles dark with `d`, so someone will press it and hit an
   untested state. Needs lighter variants in `.dark`. Blocked by: nothing.
2. **Detail drawer design.** Specified only far enough to know approvals land
   there. Needed before the "Review 3" action does anything.

## Next: engineering review

Carry into `/plan-eng-review`:

1. **`/api/dispatches` cannot render the roster.** Dispatch-centric vs
   employee-centric. `/api/roster` is still unowned. **Top item.**
2. **Dedicated dispatcher VB agent** — tools distinct from the employee-calling
   agent (roster reads + action proposals, vs brief + confirm-choice). Slot-bound
   per `VOCALBRIDGE_LEARNINGS.md:21`. **Pool caps at 5 agents** (`:24`), so a
   dispatcher agent spends one of them — that is a real budget decision.
3. **Who transcribes?** `speech-input` does it browser-side via Web Speech API;
   VB would do it in-session. Two different architectures wearing the same button.
4. **The dispatcher agent cannot be trusted with an identifier either.**
   `VOCALBRIDGE_LEARNINGS.md:20` — 0-for-4 carrying an employee id, 0-for-3 on a
   year. Same zero-parameter, slot-resolved tool discipline applies.
5. Poll interval, and whether `/api/roster` returns advisory text pre-composed by
   the worker or raw offer rows the frontend formats.
6. Where the "unambiguous" test for one-click approve lives — worker or frontend.
   It gates a real charge, so probably worker.
7. `POST /api/dev/disrupt` vs the existing `POST /api/dev/dispatch` — disruption
   and dispatch are different seams.
8. Frontend hosting: Worker-served vs Vercel (HANDOFF.md:164 open item; CORS `*`
   on the stream route already anticipates this).

---

# Engineering review (from /plan-eng-review)

Reviewed against commit `7dd6ba5`, which landed *after* the design review and
changed the schema. Local D1 was rebuilt on the current schema before reviewing.

## SCOPE CHANGE — voice is cut from v1

The voice dock, the dedicated dispatcher VB agent, the transcription decision, and
the four `@ai-elements` voice components all move to **v2**. v1 is roster + approve.

**Approve stays regardless** — see the next section for why it cannot be cut.

Forward-compat note: "the detail view must be a drawer, not a route" came only from
VB tearing down the participant on navigation. With voice gone that no longer binds
in v1. **If voice returns in v2, a routed detail view must be undone** — so prefer a
drawer anyway, and treat routing the detail view as a decision with a v2 cost.

## The finding that reframes this screen

**Nothing in the codebase can decide an approval.** `decided_at`, `decided_by`,
`decision`, `decided_offer_id` are read in four places and written in zero:

- `confirm-choice.ts:139` reads `decided_at IS NULL`
- `escalate.ts:49` reads `decided_at IS NULL`
- `confirm-choice.ts:146` and `escalate.ts:56` **insert** approvals
- nothing anywhere closes one

The voice agent only ever *opens* the gate. This dashboard is the sole thing that
can close it. It is not a read-mostly view with a button bolted on; it owns the
write half of the human-in-the-loop mechanism. `DATA_MODEL.md:154` calls
`decision = MODIFIED` "the most interesting row in the table" and nothing can
currently produce it.

## Critical fix — three impact states were rendering GREEN

Commit `7dd6ba5` added `EXECUTING`. The design-review ladder fell through to GREEN
for `EXECUTING`, `CONTACTING`, and `FAILED`. **A failed rebooking showed as "on
track" on a crisis dashboard.** Corrected and made exhaustive:

```
dispatch.status IN (DIALING, IN_CALL)   -> CALLING
impact.state = AWAITING_APPROVAL        -> NEEDS YOU     ← the only actionable one
impact.state = FAILED                   -> FAILED        ← was GREEN
impact.state = EXECUTING                -> BOOKING       ← was GREEN
impact.state = CONTACTING               -> CALLING       ← was GREEN
impact.state IN (DETECTED, TRIAGING)    -> AT RISK
impact.state = RESOLVED                 -> RESOLVED
employee.status = AT_RISK               -> AT RISK       ← structural, no impact row
employee.status = RESOLVED              -> RESOLVED
otherwise                               -> GREEN
```

Exhaustive `switch` with a `never` fallthrough, so an 8th state is a **compile
error**, not a silent GREEN. This is the bug class that produced the original
defect; the type system should prevent the repeat.

Roster gains a **sixth band**: `FAILED` fits neither "On track" nor "Waiting on
you". It needs its own treatment above the fold.

## Decisions taken

| # | Decision | Rationale |
|---|---|---|
| 1 | **Voice cut from v1** | Scope. Approve path survives; it is the only approval closer. |
| 2 | **Worker composes advisory, shares fact helpers with `speak.ts`** | One module owns carrier/airport/date/verdict facts; `speak.ts` renders for the ear, a new module for the eye. What the agent says on the phone and what the coordinator reads must not drift. |
| 3 | **Extract a shared transition module from `confirm-choice.ts`** | Voice tools and dashboard drive one state machine. Refactor first, then add the dashboard path. Only option where a double-click cannot double-ticket. |
| 4 | **Worker also computes `display_status`** | Follows from #2. A 10-branch ladder in two languages drifts — that is how `EXECUTING` got orphaned. Frontend maps status→colour and nothing else. |
| 5 | **Bun workspace + `shared/` package** | Three packages, no workspace root, and a wire type that must match on both sides. A rename becomes a compile error instead of a blank card. |
| 6 | **Worker-served frontend, single deploy** | Same origin, no CORS anywhere, one deploy. The SSE path cannot break on a preflight mid-demo. |
| 7 | **`/api/dev/disrupt` stays separate from `/api/dev/dispatch`** | Disrupt writes disruption + impacts + offers and stops. Lets the roster reach AT RISK without spending VB's 50-calls/day cap on every rehearsal. |
| 8 | **Worker tests AND frontend tests in this plan** | 38 uncovered paths, and the approve path moves money. |
| 9 | **`EXECUTING` gap flagged to the worker track** | Their file. See cross-track below. |

## Cross-track dependency — for the worker track

`confirm-choice.ts:196-221` (`writeReissue`) inserts the `action` row and sets
`selected_offer_id`, but never sets `state = 'EXECUTING'`. Commit `7dd6ba5` added
that state describing exactly this situation — "the traveller has chosen and an
`action` row is pending." **Nothing writes it, so the dashboard can never display
it.** Natural home for the fix is the shared transition module in decision #3.

## Performance — stated, not negotiable

1. **Drop `segments[]` from the roster payload.** The card renders a sentence, not
   flight rows. Including it fans 26 rows into 34. The detail drawer fetches them.
2. **Never join `booking_snapshot`.** `raw_json` is the full get-booking payload;
   reshop responses run ~170KB. It sits one FK from `itinerary` and looks innocent.
3. **Top offer is `ORDER BY rank LIMIT 1`, never `WHERE rank = 1`.** `7dd6ba5` made
   `(impact_id, rank)` UNIQUE and its comment is explicit that rank is a priority,
   not a dense sequence — "ranks 1/3/5 are read out as 1, 2, 3." `brief.ts:55`
   already renumbers by position. `WHERE rank = 1` returns nothing when offers
   start at 2.
4. **Pause the poll on `document.hidden`.** 26 rows every 5s is ~17k requests/day
   per abandoned tab against per-row read billing. Three lines.

## Test plan — 38 paths, 0 covered today

`worker/` and `frontend/` have no test config. `backend/workers/tools/` has 84
passing tests on `bun test` + miniflare + a D1 harness (`test/harness.ts`). Extend
that convention rather than inventing a second one. Frontend gets vitest +
testing-library.

### CRITICAL regression test — the codeshare

`HACKATHON_CONTEXT.md:53`: finding the fourth affected person "is the whole point."
Elena Duarte is reachable **only** through the `operating_carrier` OR-branch. A
roster query written as a plain `WHERE carrier = ...` makes her vanish and the
dashboard reports all-clear on a stranded traveller. The seed carries a second
codeshare (DL7861 flown as KE24) specifically so the bug cannot be papered over by
special-casing flight 82.

Test asserts: cancelling KE82 on 2026-09-14 returns **exactly 4** people including
Elena on marketing DL7842, and leaves the DL7861/KE24 pair untouched.

### Critical gaps — silent failures with no handling today

| Path | Fails as | Mitigation |
|---|---|---|
| Codeshare OR dropped | Elena renders nowhere; screen says all-clear | CRITICAL regression test above |
| New impact state added | Falls through to GREEN | exhaustive `never` check |
| Double-click Approve | Two `action` rows → double-ticket | shared module + idempotency key, mirroring `confirm-choice.ts:213-217` |

## NOT in scope (v1)

- Voice dock, dispatcher VB agent, transcription — **v2**, per scope decision
- Detail drawer's full visual design — specified only far enough to host approvals
- Hotel and dinner scenarios — same bands, different data
- Multi-event switching — `evt-busan` hardcoded
- Auth / operator sessions — `operator` exists in schema, no session layer
- Dark-mode status tokens — light-first; `theme-provider.tsx` toggle is untested
- Light/dark parity audit

## Outside voice (Codex) — 15 findings, 4 verified against source

**C1. Offer count was wrong.** `offer` is per `impact_id` (`schema.sql:189`), so four
impacted travellers need **12 offer rows, not 3**. The earlier plan would have given
one traveller options and left three with empty advisories.

**C2. `event_id` means two different things.** `disruption_impact.event_id` references
**`disruption_event(id)`** (`schema.sql:168`, confirmed by `brief.ts:31`), and
`disruption_event` has **no offsite FK at all** (`schema.sql:150-163`).
`/api/roster?event_id=evt-busan` collides with that name. **Scope the roster through
`employee.org_id` and `itinerary.event_id`, never through `disruption_impact.event_id`.**

**C3. Approve semantics were backwards.** `confirm-choice.ts:122-126`: `NEEDS_APPROVAL`
and `FAIL` park for approval; **`PASS` goes straight to `writeReissue` with no approval
row.** The "clear" cases need no human at all. **DECIDED: the Approve button appears
only on cards with an open approval row.** PASS cards read "agent booked this" and
offer no action. "Waiting on you" becomes the only actionable band, which is the
right product anyway.

**C4. Double-firing the admin button inflates everything.** No UNIQUE on
`disruption_impact(event_id, employee_id)` — only two plain indexes
(`schema.sql:184-185`). The dev seam must use **deterministic ids + upsert**, not
plain inserts.

Also accepted, undisputed:
- `decided_by` is set **server-side only**. Never accept an operator id from the
  browser. With no auth layer in v1, hardcode `op-coord` in the worker.
- The approval path must check `matched_num_updates` and `offer.expires_at` before
  creating a REISSUE action, per `DATA_MODEL.md:225`. Absent from the earlier plan.
- `RosterRow.status` and `display_status` contradicted each other. **One wire field:
  `display_status`.** The raw `employee.status` is not sent.
- `dispatch.status IN (FAILED, NO_ANSWER)` was unmapped. A call that fails while the
  impact sits at `CONTACTING` would render as still calling. Both map to a card that
  needs attention.

### Cross-model tensions — resolved

| Topic | Codex | Decision |
|---|---|---|
| Bun workspace | too expensive for a hackathon | **Split.** Extract the shared transition module (prevents double-ticket). Skip the workspace; frontend declares its own response type. |
| Admin scope | cut to Cancel KE82 + Reset | **Accepted.** Hotel and dinner buttons change nothing visible on a flight roster. |
| Real vs simulated demo | seed PNRs are fake | **Both true.** Every seeded PNR is `FAKE01`–`FAKE09` / `HFAKE…` (verified: 0 occurrences of a real locator in `seed.sql`). Real ticketed PNRs **do** exist — `RRQQNS` / ticket `1807361095425` and hotel `RTNTHD`, both live in CERT per `SABRE_LEARNINGS.md:12,20` — they are simply not wired in. Making the demo real = the TIER 1 swap for one employee. v1 writes `action` rows; the swap is a separate, deliberate step. |

## CRITICAL test, expanded — the codeshare has TWO failure modes

`SABRE_LEARNINGS.md:26` documents a second, independent way Elena Duarte vanishes:

> `search-flights` returns marketing identity as `marketingAirlineCode`;
> `get-booking` returns the same concept as **`airlineCode`** with no prefix.
> Reading the search names against a booking payload yields `carrier: null` and an
> affected-set index that matches nothing.

So the roster can strand her by (a) dropping the `operating_carrier` OR-branch, or
(b) normalising a `get-booking` payload with `search-flights` field names.
**Normalisers must be written per endpoint, never shared.**

Test asserts: cancelling KE82 on 2026-09-14 returns **exactly 4** people including
Elena on marketing DL7842; the DL7861/KE24 pair is untouched; and a `get-booking`
shaped payload normalises to a non-null carrier.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES FOUND | 15 findings, 4 verified against source |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 19 issues, 3 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score 4/10 → 8/10, 9 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

- **CODEX:** found 4 defects the eng review missed — offer cardinality (3 vs 12),
  the `event_id` name collision, inverted approve semantics, and non-idempotent
  dev seam. All four verified against schema and source before acceptance.
- **CROSS-MODEL:** 3 tensions, all resolved. One accepted outright (admin scope),
  one split (transition module yes, workspace no), one corrected on both sides
  (real PNRs exist but are not seeded).
- **UNRESOLVED:** 0
- **VERDICT:** ENG + DESIGN CLEARED — ready to implement.

---

# DEMO FLOW (confirmed) — this is the authoritative scope

Supersedes the earlier "voice cut from v1" decision. Voice returns in a much
smaller form; SSE leaves. Net scope is roughly flat.

## Scenario 1 — flight cancellation, live call, approval gate

```
1.  Dashboard, seed state
    24 on track. Grace Lombardi AT RISK (UA805 lands past arrival_by),
    Nora Feldman AT RISK (no itinerary). Screen is never empty.

2.  Admin → "Cancel KE82 · 14 Sep"
    Writes 1 disruption_event, 4 disruption_impact rows via the CODESHARE
    index, 12 offer rows (4 impacts × 3), cached economics, NO provider ids.
    Deterministic ids + upsert, so pressing it twice is safe.

2B. Dashboard
    4 cards flip to AT RISK — including Elena Duarte on marketing DL7842,
    which a naive carrier match would have missed. This is the whole point.
    Elena carries the REAL phone number. The other 3 are replayed.

2C. Elena's phone rings. Live conversation.
    Agent: "You're calling Elena Duarte about their Delta flight 7842..."
    Reads 3 options. Operator says "the Hong Kong one" — the $200 CX841.
    → policy_verdict = NEEDS_APPROVAL
    → confirm_choice parks it, state = AWAITING_APPROVAL
    → agent says it needs coordinator sign-off, ends the call warmly
    NOTE: this fires on the TOOL CALL, mid-conversation — not on hangup.
    `session_ended` fired only 6/8 times in testing (VB_LEARNINGS:23);
    never build a transition on hangup.

2D. Dashboard — Elena is now NEEDS YOU.
    Operator clicks Approve. Writes approval.decided_at/by/decision,
    then the action row. Card flips to RESOLVED.
    ** This is the only place in the entire codebase that closes an
       approval. It is also the product's actual claim: the agent acts
       alone inside policy and stops above it. **

2E. Meanwhile the 3 replayed cards resolve across 30-90s, staggered.
    At least one resolves IN-POLICY with no human gate, so the audience
    sees both behaviours side by side.

3.  All clear. Board returns to the shape of step 1.
```

## Scenario 2 — restaurant, voice-triggered

```
4.  Operator presses the mic: "Please help me rebook this offsite's restaurant."
    ONE-SHOT INTENT, not a conversation:
      speech-input → transcript → match intent → show what was understood
      → operator confirms → dispatch CALL_VENUE
    No dispatcher VB agent. No slot spent against the 5-agent cap.
    No Client Actions. No @ai-elements/confirmation.

4B. VB calls the venue (a real phone, a colleague). Live conversation.
    Agent negotiates the change, calls confirm_venue.
    `confirm-venue.ts` ALREADY EXISTS (138 lines) — handles CALL_VENUE +
    activity_id and writes the action rows. Backend is mostly built.

4C. SKIPPED by decision. No live board updates during the venue call.

5.  Final state matches step 1. Admin "Reset" restores the seed.
```

## Revised scope

**IN (added since eng review):**
- One-shot intent mic — `@ai-elements/speech-input`, intent match, confirm, dispatch
- Scenario 2 restaurant path — mostly `confirm-venue.ts`, already written
- Replay driver: dev endpoint replaying captured frames into CallDO on a timer,
  via the proven `/api/test/emit` seam

**OUT (removed since eng review):**
- SSE live transcript, "Listen in", in-card transcript → board updates by 5s poll
- Conversational dispatcher VB agent, Client Actions, `@ai-elements/confirmation`

**STRETCH, low priority:**
- Detail card: name + itinerary + mapbox map. When a call is live it reads from
  the CallDO. Mapbox needs an API key and a CSP allowance — small, not free.

## ⚠️ URGENT, do before anything else

`VOCALBRIDGE_LEARNINGS.md:24` — deleting the VB agents also deleted their
server-side call logs, so **"the captured event JSONL in the session scratchpad
is now the only copy."** Those frames are (a) the replay source for the 3
simulated cards and (b) the only surviving evidence behind half the VB findings.
**Copy them into `worker/fixtures/` today.** If that scratchpad is cleaned they
are gone permanently.

## Prerequisites only the human can clear

1. **Pilot subscription + provisioned phone number.** Four gates; `phone_number`
   is dashboard-only, no CLI. Without it Elena's phone cannot ring. Fallback: a
   join link opened in a phone browser — live audio, no ring. Decent, not equal.
2. **A real KE82 JFK→ICN PNR.** `RRQQNS` is KE81 ICN→JFK — the wrong leg. Needs
   a fresh `create-booking` (FOP CASH) + `fulfill-flight-tickets`, then the
   TIER 1 `UPDATE itinerary`. Proven path per `SABRE_LEARNINGS.md:12`.
3. **Rebuild the VB agent slot pool.** Account is empty as of 19:1xZ.
4. **A guard on outbound numbers.** US seed numbers are 555 (fictional, safe).
   The Korean ones `+821020000001..16` are NOT a reserved range. If PSTN is
   enabled, an allowlist must gate every dial or a fan-out reaches strangers.

## Open, minor

The mic's home. Assumed the dashboard, since a people-ops user lives there and
that is where the affordance reads as "your agent." Trivially movable to admin.
