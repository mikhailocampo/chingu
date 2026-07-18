# Fixture provenance

Read this before trusting a fixture.

## Real captures (live CERT, this session, 2026-07-18T19:23–19:27Z)

| File | Tool | Notes |
|---|---|---|
| `search-flights.jfk-icn.json` | `search-flights` | JFK→ICN 2026-09-14, ATPCO, 6 offers, `Flexibility` attributes on. Contains the KE82/DL7842 codeshare pair and the real `changeItems` fee table. Verbatim. |
| `get-booking.RRQQNS.json` | `get-booking` | Real ticketed PNR. `returnOnly` was used to bound the payload; otherwise verbatim. Contains ticket `1807361095425`, airline locator `CFVLKC`, and a live `bookingSignature`. |
| `search-hotels.jfk.json` | `search-hotels` | JFK 10mi, 2026-09-15→18. One property (CERT hotel inventory is thin). Verbatim. |
| `check-hotel-price.jfk.json` | `check-hotel-price` | Priced from the **search** `rateKey` directly, skipping `get-hotel-rates`. Verbatim. |

## Hand-written (NOT captured)

| File | Why |
|---|---|
| `reshop-flight.synthetic.json` | `reshop-flight` was outside the read-only allowlist for this task, so it was not called. Shape and numbers are reconstructed from `SABRE_LEARNINGS.md` (2026-07-18T16:41Z entry), which recorded a live run against ticket `1807361095425`: 42 offers, 41 × `Add collect` + 1 × `Even`; `grandTotal = baseFare + totalTax + totalFee` verified; `Even` $0.00 = rebooking to KE81 itself; `Add collect` $101.00 = KE85 (base $0.00 + fee $101.00); `Add collect` $153.80 = KE5033/KE7344 via MSP (base $60.00, tax −$7.20, fee $101.00). The `Refund` row is synthesised from the spec example `grandTotal: "-1539.40"` — **no live `Refund` was ever observed.** |
| `modify-booking.request.json` | Write path. Never executed. Shows the request our builder emits. |

Parsers built against hand-written fixtures are **response-shape guesses**. The
`Add collect` / `Even` / signed-amount / arithmetic behaviour is grounded in a
real recorded run; the exact JSON nesting is not.
