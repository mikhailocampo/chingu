# TODOS

Deferred work with enough context to pick up cold. Newest first.

---

## Voice approval dock (v2)

**What:** Push-to-talk voice approval for the dispatcher, backed by a dedicated
VocalBridge agent, delivered over VB Client Actions.

**Why:** Voice on both ends of the loop is the product's differentiator. The agent
already calls travellers; letting the coordinator approve by speaking closes it.

**Context:** Fully designed in `PLAN-dashboard.md` (see "Voice approval") then cut
from v1 on scope grounds during eng review. The design work is done and holds:

- `VOCALBRIDGE_LEARNINGS.md:8` says Client Actions are participant-scoped and
  "useless for the Dispatch dashboard" — that verdict is about the *employee-calling*
  agent. A dispatcher agent puts the dispatcher in the room as the participant,
  which is the one case that row carves out as legitimate.
- Two caveats survive and are load-bearing. (1) The channel has **no history or
  replay**, so D1 must remain truth and the client action is only a nudge.
  (2) Leaving the page **removes a participant from a live call**, so the detail
  view must be a drawer, not a route.
- Components chosen: `@ai-elements/speech-input` (ships the listening state),
  `@ai-elements/confirmation` (its states map 1:1 onto the approval flow),
  `@ai-elements/conversation` + `message`.

**Pros:** The demo beat. Reuses registry components rather than hand-rolling.
**Cons:** Spends one of five VB agent slots (`VOCALBRIDGE_LEARNINGS.md:24`).
Requires deciding who transcribes — browser Web Speech API vs VB in-session.

**Depends on:** v1 roster + approve shipping first. If v1 routes the detail view
instead of using a drawer, that must be undone before this lands.

---

## `EXECUTING` is never written (cross-track)

**What:** `confirm-choice.ts:196-221` (`writeReissue`) inserts the `action` row and
sets `selected_offer_id` but never sets `state = 'EXECUTING'`.

**Why:** Commit `7dd6ba5` added that state describing exactly this situation — "the
traveller has chosen and an `action` row is pending" — explicitly so a dashboard
could tell it apart from "ticket reissued." Nothing writes it, so the dashboard can
never display it.

**Context:** Owned by the worker/tools track, not the frontend track. The natural
home for the fix is the shared transition module being extracted for the dashboard's
approve path. The 84 existing tools tests must stay green.

**Depends on:** the transition module extraction.

---

## `disruption_impact` has no uniqueness constraint

**What:** No UNIQUE on `(event_id, employee_id)` — only two plain indexes at
`schema.sql:184-185`.

**Why:** Firing the same disruption twice inflates the roster, the exposure total,
and the approval count. Found by Codex during eng review.

**Context:** v1 works around it with deterministic ids + upsert in the dev seam,
which is sufficient for the demo. A real producer would want the constraint. Note
the schema author already hit and documented a circular-FK problem in this area
(`7dd6ba5`), so changes here deserve care.

**Depends on:** nothing. Blocked by: whether a real disruption producer ships.

---

## Dark-mode status tokens

**What:** Light-mode variants of `--status-ok/risk/calling/needs` exist; dark ones
do not.

**Why:** `theme-provider.tsx` already toggles dark with the `d` key, so someone will
press it and land in an untested state. The four status colors are tuned for white
and will misbehave on `oklch(0.145 0 0)`.

**Context:** The dark mockup at
`~/.gstack/projects/mikhailocampo-chingu/designs/dashboard-roster-20260718/wireframe-a.html`
has working dark values to lift.

**Pros:** Cheap. **Cons:** None, it's just not v1.

---

## Detail drawer visual design

**What:** The drawer is specified only far enough to know approvals land there.
The three priced options, policy verdict, and segment list need real layout.

**Why:** It's where a coordinator compares a $120 in-policy option against a $200
one that arrives sooner. That comparison is the actual decision.

**Depends on:** v1 roster shipping. Would benefit from `/plan-design-review`.
