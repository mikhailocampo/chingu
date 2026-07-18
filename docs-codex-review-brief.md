# Review brief: Chingu data model

You are reviewing a proposed data model before it gets locked in. Be adversarial. We want it broken now, not during the demo.

## Business context

**Chingu** — B2B SaaS for people-ops teams running corporate offsites. Hackathon project; we are not a real company but are presenting as one.

**Client** — Samsung. Coordinating travel for N employees to one offsite. Employees split across Korea and the US. Legs get cancelled or need changing.

**Product premise: "Dispatch"** — an agent that *acts* rather than showing a dashboard. Two halves:
- **Voice** (VocalBridge SDK) — the agent phones hotels, restaurants, employees.
- **Data centralization** (Sabre GDS API) — one source of truth for everyone's itinerary.

The differentiation is **triage**, not booking: noticing a disruption, working out who is affected across two continents, picking the cheapest option, closing the loop by voice without a human.

## Three demo scenarios

1. **Flight rebooking** (verified working). Flight cancelled → agent finds alternatives → shows real cost to change. Live: KE81 ICN→JFK cancelled → KE85 same day for $101 (pure change fee), or via Minneapolis for $153.80. One option $0.00.
2. **Hotel modification** (booking works, modify untested). Offsite dates shift → N employees' hotel stays move.
3. **Restaurant / dietary** (no Sabre involvement). One employee allergic to shellfish; agent calls the restaurant, then calls the employee back.

## Hard-won facts about the Sabre API (all verified live against their CERT sandbox)

These constrain the model. Please treat as ground truth.

1. **There is NO list or search endpoint over bookings.** `get-booking` takes a `confirmationId` (PNR locator) and nothing else. You cannot ask "which bookings belong to this event / traveler / PCC". This is the single biggest constraint.
2. **Nothing groups travelers into a trip.** Each booking is an unrelated PNR. No concept of an "event" or "group".
3. **A PNR can hold multiple travelers, but everything references them positionally** — `travelerIndices: [1]`, `nameAssociationId: "1"`, `leadTravelerIndex`. Indices shift.
4. **A PNR can hold flights AND hotels together** (`allSegments[]` normalizes across types), or they can be separate PNRs. Our proposal keeps them separate — see below.
5. **`modify-booking` uses optimistic locking.** It requires a `bookingSignature` from a *fresh* `get-booking`, and the schema warns it cannot be reused after any other operation modifies the booking. Concurrent modifies to one PNR will collide.
6. **Two locators per booking.** Sabre PNR (`RRQQNS`) vs the supplier's own (`CFVLKC` for Korean Air, `3446798630-` for the hotel). When the voice agent phones a supplier it must quote the *supplier's* locator.
7. **Sabre returns a lot for free** — segments, journeys, fare construction, per-code tax breakdown, baggage allowance and excess-bag pricing, ticket coupon status, SSRs, accounting lines, `isCancelable`/`isTicketed`, and `fareRules` with refund/exchange penalties. We do not want to rebuild any of this.
8. **Flights and hotels change via different APIs.** Flights: reshop → ticket reissue. Hotels: `modify-booking`.
9. **CERT (sandbox) gets rebuilt periodically and silently wipes PNRs.**
10. **Hotel `bookingKey` expires in ~7 minutes**; flight offers in ~20.
11. Hotel bookings require a credit card guarantee (test Visa works in sandbox). Flights can be ticketed with form-of-payment `CASH`, no card.
12. `get-booking` also returns `numberOfUpdates` (an integer that increments) alongside `bookingSignature`.

## Proposed model

```
Org(samsung)
  Event(offsite, dates, city)
    Employee(name, email, phone, home_city, dietary[], passport_ref)
    TripRecord(employee_id, event_id, component: FLIGHT|HOTEL,
               sabre_pnr, supplier_locator, ticket_number,
               booking_signature, num_updates, synced_at)

    -- denormalized from Sabre; this is what we actually query --
    Segment(trip_record_id, type,
            carrier_or_chain,        -- KE / GI
            flight_no | property_id, -- 81 / 100105512
            start_date, end_date, origin, dest, status)

  -- Chingu-native, no Sabre equivalent --
  Activity(event_id, type: DINNER, venue, phone, starts_at)
    Attendance(activity_id, employee_id, state)

  -- workflow --
  DisruptionCase(trip_record_id?, activity_id?, state, chosen_option, cost_delta)
  CallLog(case_id, direction, transcript, outcome)
```

### Design decisions we made and want challenged

- **One employee per PNR** (not N travelers per PNR) — because of positional indices and blast radius.
- **Separate PNRs for flight vs hotel** (not combined) — because `modify-booking` locks per PNR, so a hotel date-shift would contend with a flight rebooking; and the two use different APIs anyway.
- **Denormalize segments into our own table** — because Sabre cannot answer "who is on KE81 on Sep 15".
- **Sabre is truth; our rows are a cache.** Store `booking_signature` + `num_updates`, re-sync before acting.

### Queries the model must serve

- "Find all employees affected by this airline cancellation" (carrier + flight number + date → N employees)
- "This dinner needs rescheduling for all employees at the offsite" (one Activity row → N Attendance rows → N voice calls)

## What we want from you

Stress test it. Specifically:

1. **Where does this model break?** Cardinality errors, missing entities, wrong grain, things that will not survive contact with the demo.
2. **Are the four design decisions right?** Especially separate-vs-combined PNRs and one-traveler-per-PNR. Argue the other side if it is stronger.
3. **Cache coherence.** Sabre is truth, our rows are a cache, and there are no webhooks — we poll. Where does staleness bite? Is `num_updates` + `booking_signature` enough to detect drift? What happens when a segment changes underneath an in-flight DisruptionCase?
4. **The event-stream / triage path.** Is `Segment` the right grain to match a cancellation event against? What does a real cancellation event actually key on, and would this schema match it?
5. **Concurrency.** N employees, parallel Sabre operations, per-PNR locking. What race conditions are we not seeing?
6. **What is missing entirely?** Idempotency, audit, retries, partial failure, multi-leg trips, employees on the same flight, cancelled-then-rebooked history, consent for voice.
7. **What is over-modeled** for a hackathon? Be blunt about what to cut for speed.

Rank your findings by severity. Be concrete — name the entity and field. Do not be agreeable; we want the problems.
