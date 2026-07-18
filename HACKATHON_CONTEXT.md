# Chingu — Hackathon Context

Pointers, not a spec. See `SABRE_LEARNINGS.md` for verified API findings.

## The setup

**Chingu** — B2B SaaS. AI for people-ops teams running offsites and events.
**Client** — Samsung. **Global Offsite, Busan, 15–18 Sep 2026.**
**Twist** — employees are split across Korea and the US. Legs get cancelled or need changing.

**The roster (26 people)** — seeded in `worker/seed.sql`:

| Cohort | Count | Travel |
|---|---|---|
| Korea-based | 16 | Already in country. Hotel only, no flights. |
| US-based | 9 | Fly JFK or SFO → ICN on 14 Sep. |
| Not yet booked | 1 | No itinerary at all — an agent has to collect her details. |

Flights in the seed are **real** CERT inventory. Korean hotels are **faked** — CERT has zero Korean hotel data (verified).

## The premise: Dispatch

The agent doesn't just show you a dashboard. It **acts** — calls, rebooks, confirms.

Two halves:
- **Voice** (VocalBridge) — the agent talks to hotels, restaurants, employees.
- **Data centralization** (Sabre) — one source of truth for everyone's itinerary.

## Employee data model

N employees, two states:

**Has an itinerary** → we have a ticket. This is the good case.
- Needs: `ticketNumber` (13-digit, from `get-booking`)
- Unlocks: reshop / exchange, real fare differences
- Everything else about them is already in the PNR

**No itinerary yet** → agent has to collect enough to book them.
- To *search*: nothing personal. Just route + date.
- To *book*: `givenName`, `surname`, `birthDate`, `passengerCode` (`ADT`), plus contact email + phone
- To book *international*: passport — number, expiry, issuing country, residence country, gender
- To *ticket*: a form of payment. `CASH` works and needs no card. ← this is what makes the demo possible

So the data requirement **escalates** as you move down the funnel. Searching is free. Booking needs identity. Ticketing needs payment. Reshop needs a ticket.

That escalation is the interesting product surface — the agent should only ask for what the *next* step needs, not everything up front.

## Three scenarios

### 1. Flight rebooking — DONE, verified
**KE82 JFK→ICN on 14 Sep is cancelled.** Agent finds alternatives → shows the real cost to change → calls each affected traveller → books what they pick.

**Four people are affected, and finding the fourth is the whole point.** Three are ticketed on marketing KE82. The fourth is on **DL7842 — the same aircraft**, sold by Delta. Match the cancellation on marketing carrier alone and she is silently stranded while the dashboard reports all-clear. The seed contains a second codeshare (DL7861 flown as KE24) so nobody "fixes" this by special-casing flight 82.

Real alternatives from CERT, with real change fees:

| Option | Fare | Change fee | Verdict vs policy |
|---|---|---|---|
| OZ223 JFK 01:30 → ICN 06:05+1 | $1,071.40 | $120 | PASS |
| CX841+CX416 via Hong Kong | **$559.30** | **$200** | NEEDS_APPROVAL |
| UA805 SFO (basic economy) | $338.50 | **$299**, non-refundable | NEEDS_APPROVAL |

Change fees are visible at *search* time, so we quote without a ticket, a PNR, or a card.

### ⚠️ Cheapest is not best — and the system computes that
The cheap options are the **worst** ones. $559 carries the highest change fee and lands late; $338 is non-refundable with a $299 change fee and arrives 04:20 on day 2 — **past `event.arrival_by`**, so that traveller is flagged `AT_RISK` before any disruption even happens.

`Event` therefore carries `timezone`, `arrival_by` and `depart_after`, not just dates. **Do not lose this** — it is the difference between a price lookup and triage, and it is the line the demo turns on: *"the cheapest option gets him there after the dinner he is supposed to host."*

### 2. Hotel modification — partly explored
Offsite dates shift → N employees' hotel stays need moving.

Agent calls the hotel by voice and does whatever it takes — modify the booking, collect whatever info the hotel asks for.

**Booked and confirmed.** PNR **RTNTHD**, hotel confirmation **3446798630-**, Hilton Garden Inn JFK, 15–18 Sep, $935.55, status `HK`.

- Hotels **do** require a card — `CASH`, `AGENCY_NAME` and `LATE` are all rejected by the property. But the standard test Visa `4111111111111111` works in CERT. Nothing is charged; Sabre stores a masked guarantee and passes it to the hotel.
- Rate choice at booking decides whether a later change is free — FLEXIBLE cancels free until check-in day, RESTRICTED four days out.
- Changing dates *within* the original range is cheap (no re-pricing). Extending beyond it needs a full re-shop.
- Hotel `bookingKey` dies in ~7 minutes. Collect guest data first, then price-check and book back to back.
- The booking response includes the **property's phone number** — that's what the voice agent dials, no lookup needed.

**Still open:**
- Execute the actual date-shift via `modify-booking` (we have everything needed; not yet run).
- Do we modify via Sabre API, via voice, or show both? Voice is the differentiator; the API now works either way.
- If voice: what does the agent need to hold to be credible on the phone? (confirmation number, guest name, dates)
- Fan-out — one call per employee, or one call for the whole block? Note Sabre serializes modifies per PNR, so parallelism has to be across employees, not within one booking.

### 3. Restaurant / dietary — the voice-first variant
Welcome dinner, **day 2 (16 Sep) 19:30 KST**, at a Busan seafood restaurant. All 26 attend.

**Priya Natarajan has a severe shellfish allergy.** The venue is a seafood place — that's the scenario, not an oversight in the seed.

- VocalBridge calls the restaurant → confirms accommodation, or moves the booking
- Then fans out to **all 26** attendees — one idempotent notification each
- Then calls Priya back to confirm

This is the widest-blast-radius event: one venue call, 26 downstream updates. Note `disclose_ok` on the dietary record — telling a restaurant about an allergy discloses a health fact, so the agent checks before it speaks.

Same Dispatch pattern as #2, no Sabre involved. Good demo beat because it shows voice working both outbound *and* back to the traveler — the loop closes.

## Demo notes

- Everything stays in **CERT**. Never book in production — real suppliers get billed.
- Test PNR `RRQQNS` / ticket `1807361095425` already exists and is reusable for reshop.
- Search offers expire in **20 minutes**. Re-run searches live; don't cache IDs from rehearsal.
- Reshop responses are ~170KB. Needs filtering before anything reads it.

## Where the differentiation is

Not the booking. Anyone can call an API.

It's the **triage** — noticing the disruption, working out who's affected across two continents, picking the option that costs least *and still lands before dinner*, and closing the loop by voice.

Not "no human in the loop" — **the right human, only when it matters.** The agent acts alone inside company policy and escalates above it. A $0 same-day rebooking goes through untouched; a $400 add-collect goes to Samsung's coordinator with the options already priced. Every action records whether it was autonomous or authorised, and where a human overruled the agent. See `DATA_MODEL.md`.
