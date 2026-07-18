# Chingu — Data Model

> **The executable contract is `worker/schema.sql`.** It supersedes the sketch in
> `HANDOFF.md` and reconciles it with this document. Parallel work reads the SQL;
> this file explains *why* the shapes are what they are.
>
> Reconciled since first draft: `policy_evaluation` folded into `offer`;
> `activity_change` folded into `action.result_json`; `dietary_need` folded into
> `employee.dietary_json`; execution split by executor into `dispatch` (VB calls)
> vs `action` (Sabre writes and non-voice notifications); `agent_slot` added for
> VB correlation. `booking_signature` is deliberately not persisted.

Reference, not a migration. See `SABRE_LEARNINGS.md` for the verified API facts this rests on.

## The one rule

**Sabre is the system of record for itineraries. We are the index and the workflow.**

Sabre has no list or search endpoint — `get-booking` takes a locator and nothing else. So we cannot find our own bookings without keeping our own index. That is the entire reason this schema exists.

`BookingSnapshot` holds truth (raw JSON). `Segment` is a flattened query index. Never rebuild fare rules, baggage, taxes, or SSRs — read them from the snapshot.

---

## Entities

### Org and policy

```
Org(id, name)                                    -- Chingu's customer, e.g. Samsung
Event(id, org_id, name, city, timezone,
      starts_at, ends_at,
      arrival_by, depart_after)                  -- travel windows, not just dates

Policy(id, org_id, event_id?,                    -- event_id set = override for this offsite
       domain: FLIGHT | HOTEL | DINING,
       version, effective_from,
       -- typed: the few things we filter on in SQL --
       max_add_collect, currency, cabin_max,
       max_nightly_rate, per_head_budget,
       requires_approval_over,
       -- everything else --
       rules_json)
```

Policy is **hybrid on purpose**. Agents consume policy as a block of context, so most of it lives in `rules_json` (preferred carriers, layover limits, refundable-only, alcohol, dietary accommodation required). But the handful of limits we *machine-enforce* are typed columns so triage can filter without parsing JSON.

Scoped `org_id` with optional `event_id` override — Samsung's default may be economy, but the Korea legs of this offsite may allow premium.

`version` + `effective_from` matter because of:

```
PolicyEvaluation(offer_id, policy_id, policy_version,
                 verdict: PASS | NEEDS_APPROVAL | FAIL,
                 reason, evaluated_at)
```

When the agent books something, we must be able to say *which policy version it was judged against*. Without this, "the agent followed policy" is unfalsifiable.

### People and trips

```
Employee(id, org_id, name, email, phone, home_city, timezone)

TripRecord(id, employee_id, event_id, component: FLIGHT | HOTEL,
           sabre_pnr, ticket_number,
           last_num_updates, last_synced_at, poll_status, poll_error)

BookingSnapshot(id, trip_record_id, raw_json, num_updates, fetched_at)
```

No `booking_signature` — it is operation-scoped, must come from a fresh `get-booking` immediately before a modify, and persisting it invites reuse of a dead one.

No `passport_ref` — Sabre already holds the passport in the PNR. Mirroring it buys nothing and costs a privacy problem.

### Segment — the query index

```
Segment(id, trip_record_id, type: FLIGHT | HOTEL,
        sabre_item_id, supplier_locator,

        -- flight --
        carrier, flight_no,
        operating_carrier, operating_flight_no,
        origin, dest,
        dep_date, dep_time, arr_date, arr_time,

        -- hotel: every field modify-booking demands --
        property_id, chain_code, product_code, rate_code,
        payment_policy, num_guests, lead_traveler_index,
        check_in, check_out, cancel_by,

        raw_status_code, status)
```

Three things here are load-bearing:

- **`operating_carrier` / `operating_flight_no`.** KE81 and DL7841 are the *same aircraft* — one is a codeshare. Match a cancellation on marketing carrier alone and you silently miss everyone ticketed on the codeshare.
- **`arr_date` / `arr_time`.** Needed to answer "does this rebooking still get them there before dinner." Cheapest is not acceptable if it arrives late.
- **The hotel block.** `modify-booking` requires `itemId`, `productCode`, `paymentPolicy`, `numberOfGuests`, `leadTravelerIndex` on *every* hotel modify. If we do not persist them, scenario 2 cannot execute.

### Disruption and action

```
DisruptionEvent(id, source, kind,
                carrier, flight_no, dep_date,        -- flight cancellations
                activity_id?,                        -- or a venue problem
                detected_at, raw_payload)

DisruptionImpact(id, event_id, employee_id, trip_record_id,
                 state: DETECTED | TRIAGING | AWAITING_APPROVAL
                      | CONTACTING | RESOLVED | FAILED,
                 previous_state, state_changed_at,          -- transition trace
                 matched_segment_id, matched_num_updates,   -- staleness guard
                 selected_offer_id, resolved_at)

OfferSnapshot(id, impact_id, provider_offer_id, expires_at,
              charge_type: ADD_COLLECT | EVEN | REFUND,
              currency, fare_delta, tax_delta, fee_delta, total_delta,
              route_summary, arrives_at, raw_json)

ActionAttempt(id, subject_type, subject_id, employee_id?,
              kind: RESHOP | REISSUE | HOTEL_MODIFY | CALL_SUPPLIER
                  | CALL_EMPLOYEE | NOTIFY,
              actor_kind: AGENT | COORDINATOR | CHINGU_OP | SYSTEM,
              actor_id?,                                    -- null when AGENT/SYSTEM
              approval_id?,                                 -- set if gated
              idempotency_key, state, external_ref,
              request_hash, attempt_no, error, completed_at)

CallLog(id, attempt_id, callee, phone_dialed, external_call_id,
        consent, transcript, extracted, started_at, ended_at)
```

### Human in the loop

The agent acts autonomously *within* policy and escalates above it. That gate needs modelling, not just a state name.

```
Operator(id, org_id?, name, email,
         role: CHINGU_OP | COORDINATOR)          -- org_id null = Chingu staff

Approval(id, impact_id, offer_id,
         reason: OVER_THRESHOLD | POLICY_FAIL | AGENT_UNSURE | MANUAL_HOLD,
         requested_at, requested_by_attempt_id,
         decided_at, decided_by,                 -- Operator
         decision: APPROVED | REJECTED | MODIFIED,
         decided_offer_id,                       -- set when MODIFIED
         note)
```

`Operator` is distinct from `Employee` — travellers are not users of the system. A Samsung coordinator approving a $400 add-collect is an `Operator`; the person flying is an `Employee`.

`decision: MODIFIED` matters. A coordinator rarely just approves — they pick a *different* option. `decided_offer_id` captures that the human overrode the agent's choice, which is the most interesting row in the table.

**The gate is driven by data already present:** `Policy.requires_approval_over` sets the threshold, `PolicyEvaluation.verdict = NEEDS_APPROVAL` trips it, `DisruptionImpact.state = AWAITING_APPROVAL` parks it, and `ActionAttempt.approval_id` proves the action was authorised before it fired. Nothing new is invented — the pieces just now connect.

**One event, N impacts.** A KE81 cancellation is a single event affecting many employees, each with their own PNR, options, and outcome. Anchoring a "case" to one trip record cannot express that.

**`ActionAttempt` carries an idempotency key** because every one of these is an externally visible side effect. We already hit this: `fulfill-flight-tickets` returned `UNABLE_TO_RETRIEVE_TICKETS` while the ticket had actually issued — a naive retry double-tickets. The same shape double-dials an employee.

**`charge_type` is typed** because reshop returns `Add collect` / `Even` / `Refund`, and we saw a real $0.00 `Even`. A single signed number cannot distinguish "free change" from "no data."

### Activities — the non-Sabre half

```
Activity(id, event_id, kind: DINNER | MEETING,
         venue, phone, address, starts_at, timezone, capacity)

ActivityChange(id, activity_id, from_starts_at, to_starts_at,
               reason, confirmed_at, confirmed_via_attempt_id)

Attendance(id, activity_id, employee_id,
           attend_state: INVITED | CONFIRMED | DECLINED | UNAVAILABLE)

DietaryNeed(id, employee_id, kind, severity, notes, disclose_ok)
```

**Attendance and notification are two different axes.** Whether someone is coming is `Attendance.attend_state`. Whether they have been *told* the time moved is an `ActionAttempt(kind: NOTIFY, employee_id)`. Collapsing them means you cannot tell "declined" from "we never reached them."

`disclose_ok` exists because telling a restaurant about someone's allergy is disclosing a health fact. The agent should know whether it may.

---

## Questions the model must answer

These are the acceptance tests. If a change breaks one of these, the change is wrong.

### A. Coordinator — aggregation

> Samsung's people coordinator wants a view, not a booking.

| Question | Path |
|---|---|
| Who is affected if KE81 on 15 Sep is cancelled? | `Segment` on `(carrier, flight_no, dep_date)` **OR** `(operating_carrier, operating_flight_no, dep_date)` → `TripRecord` → `Employee` |
| What is our total exposure on this disruption? | `SUM(OfferSnapshot.total_delta)` over selected offers for `DisruptionImpact.event_id` |
| How many are still unresolved? | `DisruptionImpact` grouped by `state` |
| Who have we not managed to reach? | `ActionAttempt` where `kind IN (CALL_EMPLOYEE, NOTIFY)` and `state != COMPLETED` |
| Who now arrives after the dinner? | `Segment.arr_time` vs `Activity.starts_at`, both normalised via `Event.timezone` |
| Are we over budget for the offsite? | `SUM(total_delta)` vs `Policy.per_head_budget` × headcount |
| What is waiting on my approval right now? | `Approval WHERE decided_at IS NULL` → `DisruptionImpact` → `Employee` |
| What did the agent do on its own vs what did we authorise? | `ActionAttempt` grouped by `actor_kind`, `approval_id IS NULL` |
| Where did a human overrule the agent? | `Approval WHERE decision = 'MODIFIED'`, compare `decided_offer_id` to `selected_offer_id` |

The codeshare `OR` in row one is the whole reason `operating_carrier` exists.

### B. Agent — resolving one cancelled flight

> The agent has Sabre tools. It needs *context*, not plumbing.

Assemble a **case packet** — a read model, not a table:

1. **Who** — `Employee` (name, phone, timezone)
2. **What they have now** — all `Segment` rows for *both* their `TripRecord`s, flight and hotel. The agent must see the hotel even though only the flight broke.
3. **What broke** — `DisruptionImpact` → `DisruptionEvent`
4. **What Sabre needs to change it** — `TripRecord.ticket_number` plus `Segment.sabre_item_id`; coupon detail from `BookingSnapshot.raw_json`
5. **What the company accepts** — `Policy` for `(org, event, FLIGHT)`, event override winning
6. **What is on offer** — `OfferSnapshot` rows, each with a `PolicyEvaluation` verdict attached
7. **What has already been tried** — `ActionAttempt` history, so a retry does not double-book
8. **Knock-on effects** — does the new `arr_time` break `Segment.check_in` on the hotel, or `Activity.starts_at` for the dinner?
9. **Whether it may act alone** — `PolicyEvaluation.verdict`. `PASS` → book. `NEEDS_APPROVAL` → open an `Approval`, park at `AWAITING_APPROVAL`, do not call Sabre. The agent must never write before the gate clears.

Point 8 is the triage story. Rebooking a flight in isolation is a lookup; noticing it strands the hotel is the product.

**Before acting**, re-fetch and compare `num_updates` against `DisruptionImpact.matched_num_updates`. If it moved, the itinerary changed underneath us — re-triage rather than apply a decision made against a stale segment.

### C. Agent — calling the restaurant

> One venue call, then N employee calls.

**Before dialling:**

| Needs | From |
|---|---|
| Venue and number | `Activity.venue`, `Activity.phone` |
| How many are coming | `COUNT(Attendance WHERE attend_state = CONFIRMED)` |
| Dietary constraints it may disclose | `DietaryNeed` joined on confirmed attendees, `WHERE disclose_ok` |
| What the company will pay | `Policy(org, event, DINING).per_head_budget`, `rules_json` |
| Whether anyone's flight makes the old time impossible | `Segment.arr_time` vs `Activity.starts_at` |

**Confirming the change:** `ActionAttempt(kind: CALL_SUPPLIER)` → `CallLog` → on success write `ActivityChange` with `confirmed_via_attempt_id` and update `Activity.starts_at`.

**Fanning out:** one `ActionAttempt(kind: NOTIFY, employee_id)` per confirmed attendee, each with its own idempotency key. Per-employee delivery state lives there — `Attendance` stays about attendance. Re-running the fan-out after a partial failure retries only the ones that did not complete.

This is the same machinery as the flight case, which is the point: **supplier action, then fan-out, both idempotent.**

---

## Deliberately not modelled

Kept in `BookingSnapshot.raw_json`, indexed only if a query needs it:

- Ticket coupons, EMDs, void/refund history
- Fare construction, tax breakdown, baggage and excess-bag pricing
- SSRs, OSIs, accounting lines, remarks
- A parent `Itinerary` grouping an employee's flight and hotel PNRs — `(employee_id, event_id)` already gives us that
- A `SupplierReference` table — `Segment.supplier_locator` is enough at this scale

We are not building a TMC. `Segment` is an index; the snapshot is the truth.

---

## Open

- `modify-booking` date shift is still unexecuted — the one operation in section C not yet proven.
- Seeds must be a **re-runnable script**, not fixtures. CERT is rebuilt periodically and silently wipes PNRs; a hardcoded `RRQQNS` will die mid-hackathon.
- No webhooks exist. "Sabre is truth" means polling known PNRs — `poll_status` / `last_synced_at` are the cursor.
