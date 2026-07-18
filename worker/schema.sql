-- Chingu — D1 schema (reconciled)
-- Supersedes the sketch in HANDOFF.md and the prose model in DATA_MODEL.md.
-- This file is the contract. Parallel work should read this, not the prose.
--
-- Conventions:
--   ids        TEXT (ulid)
--   timestamps TEXT, ISO-8601 UTC
--   booleans   INTEGER 0/1
--   money      TEXT decimal string (never REAL) + separate currency
--
-- Rule: Sabre is the system of record for itinerary CONTENT.
-- We store what lets us FIND a booking and what Sabre does not model at all.
-- Never mirror fare construction, taxes, baggage or SSRs — read booking_snapshot.

------------------------------------------------------------------ tenancy

CREATE TABLE org (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL
);

CREATE TABLE operator (               -- users of Chingu. NOT travellers.
  id            TEXT PRIMARY KEY,
  org_id        TEXT REFERENCES org(id),   -- NULL = Chingu staff
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('CHINGU_OP','COORDINATOR'))
);

CREATE TABLE event (                  -- the offsite
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org(id),
  name          TEXT NOT NULL,
  city          TEXT,
  timezone      TEXT NOT NULL,             -- IANA, e.g. America/New_York
  starts_at     TEXT,
  ends_at       TEXT,
  arrival_by    TEXT,                      -- travel windows, not just dates
  depart_after  TEXT
);

CREATE TABLE employee (               -- travellers. Not system users.
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES org(id),
  name          TEXT NOT NULL,
  email         TEXT,
  phone_e164    TEXT,                      -- ^\+[1-9]\d{6,14}$ for VB
  home_base     TEXT,
  timezone      TEXT,
  dietary_json  TEXT,                      -- [{kind,severity,notes,disclose_ok}]
  status        TEXT NOT NULL DEFAULT 'OK'
                CHECK (status IN ('OK','AT_RISK','DELAYED','RESOLVED'))
);
CREATE INDEX idx_employee_org ON employee(org_id);

------------------------------------------------------------------ policy

-- Hybrid on purpose: typed columns for what we filter on in SQL,
-- rules_json for what the agent reads as context.
CREATE TABLE policy (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES org(id),
  event_id              TEXT REFERENCES event(id),   -- NULL = org default
  domain                TEXT NOT NULL CHECK (domain IN ('FLIGHT','HOTEL','DINING')),
  version               INTEGER NOT NULL DEFAULT 1,
  effective_from        TEXT NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD',
  max_add_collect       TEXT,
  cabin_max             TEXT,
  max_nightly_rate      TEXT,
  per_head_budget       TEXT,
  requires_approval_over TEXT,                       -- gate threshold
  rules_json            TEXT
);
CREATE INDEX idx_policy_lookup ON policy(org_id, event_id, domain);

------------------------------------------------------------------ sabre index

CREATE TABLE itinerary (
  id                 TEXT PRIMARY KEY,
  employee_id        TEXT NOT NULL REFERENCES employee(id),
  event_id           TEXT NOT NULL REFERENCES event(id),
  component          TEXT NOT NULL CHECK (component IN ('FLIGHT','HOTEL')),
  pnr                TEXT NOT NULL,          -- Sabre locator
  ticket_number      TEXT,
  last_num_updates   INTEGER,                -- drift detection
  last_synced_at     TEXT,
  poll_status        TEXT,
  poll_error         TEXT,
  status             TEXT
  -- NOTE: booking_signature is deliberately NOT stored. It is operation-scoped
  -- and must be fetched fresh from get-booking immediately before any modify.
);
CREATE INDEX idx_itin_employee ON itinerary(employee_id, event_id);
CREATE INDEX idx_itin_pnr      ON itinerary(pnr);

CREATE TABLE booking_snapshot (       -- raw get-booking. This is the truth.
  id            TEXT PRIMARY KEY,
  itinerary_id  TEXT NOT NULL REFERENCES itinerary(id),
  raw_json      TEXT NOT NULL,
  num_updates   INTEGER,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX idx_snap_itin ON booking_snapshot(itinerary_id, fetched_at DESC);

-- Denormalised ONLY so triage is a real WHERE. Flights and hotels share this
-- table, mirroring Sabre's own allSegments[].
CREATE TABLE segment (
  id                    TEXT PRIMARY KEY,
  itinerary_id          TEXT NOT NULL REFERENCES itinerary(id),
  type                  TEXT NOT NULL CHECK (type IN ('FLIGHT','HOTEL')),
  sabre_item_id         TEXT,
  supplier_locator      TEXT,                -- airline/hotel locator, NOT the PNR

  -- flight
  carrier               TEXT,
  flight_no             INTEGER,
  operating_carrier     TEXT,                -- codeshare: KE81 == DL7841
  operating_flight_no   INTEGER,
  origin                TEXT,
  dest                  TEXT,
  dep_date              TEXT,
  dep_time_utc          TEXT,
  arr_date              TEXT,
  arr_time_utc          TEXT,                -- needed for "lands before dinner"

  -- hotel: every field modify-booking demands
  property_id           TEXT,
  chain_code            TEXT,
  property_phone        TEXT,                -- what the voice agent dials
  product_code          TEXT,
  supplier_rate_code    TEXT,
  payment_policy        TEXT,
  num_guests            INTEGER,
  lead_traveler_index   INTEGER,
  check_in              TEXT,
  check_out             TEXT,
  free_cancel_until     TEXT,

  raw_status_code       TEXT,                -- HK, NN, ...
  status                TEXT
);
-- the two triage lookups; both must be indexed (codeshare match)
CREATE INDEX idx_seg_marketing ON segment(carrier, flight_no, dep_date);
CREATE INDEX idx_seg_operating ON segment(operating_carrier, operating_flight_no, dep_date);
CREATE INDEX idx_seg_itin      ON segment(itinerary_id);

------------------------------------------------------------------ disruption

CREATE TABLE disruption_event (       -- written by the simulated producer
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                CHECK (kind IN ('FLIGHT_CANCELLED','FLIGHT_DELAYED','VENUE_CHANGE_REQUIRED')),
  carrier       TEXT,
  flight_no     INTEGER,
  dep_date      TEXT,
  origin        TEXT,
  dest          TEXT,
  activity_id   TEXT,                        -- venue events
  reason        TEXT,
  raw_payload   TEXT,
  detected_at   TEXT NOT NULL
);

-- One event, N impacts. This is the per-employee triage row.
CREATE TABLE disruption_impact (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL REFERENCES disruption_event(id),
  employee_id          TEXT NOT NULL REFERENCES employee(id),
  itinerary_id         TEXT REFERENCES itinerary(id),
  -- EXECUTING = the traveller has chosen and an `action` row is pending.
  -- Without it there is no state between "chose an option" and "ticket
  -- reissued", so a dashboard polling state alone cannot tell the two apart.
  state                TEXT NOT NULL DEFAULT 'DETECTED'
                       CHECK (state IN ('DETECTED','TRIAGING','AWAITING_APPROVAL',
                                        'CONTACTING','EXECUTING','RESOLVED','FAILED')),
  previous_state       TEXT,
  state_changed_at     TEXT,
  matched_segment_id   TEXT REFERENCES segment(id),
  matched_num_updates  INTEGER,              -- staleness guard: compare before acting
  selected_offer_id    TEXT,
  resolved_at          TEXT
);
CREATE INDEX idx_impact_event ON disruption_impact(event_id, state);
CREATE INDEX idx_impact_emp   ON disruption_impact(employee_id);

-- Precomputed BEFORE dialing. The voice agent reads these; it never searches.
-- policy verdict folded in (no separate policy_evaluation table).
CREATE TABLE offer (
  id                 TEXT PRIMARY KEY,
  impact_id          TEXT NOT NULL REFERENCES disruption_impact(id),
  rank               INTEGER NOT NULL,       -- 1..3, what the agent reads out
  provider_offer_id  TEXT,
  expires_at         TEXT,                   -- flight ~20min, hotel key ~7min
  charge_type        TEXT CHECK (charge_type IN ('ADD_COLLECT','EVEN','REFUND')),
  currency           TEXT,
  fare_delta         TEXT,
  tax_delta          TEXT,
  fee_delta          TEXT,
  total_delta        TEXT,
  route_summary      TEXT,                   -- speakable
  arrives_at         TEXT,
  policy_verdict     TEXT CHECK (policy_verdict IN ('PASS','NEEDS_APPROVAL','FAIL')),
  policy_id          TEXT REFERENCES policy(id),
  policy_version     INTEGER,
  policy_reason      TEXT,
  raw_json           TEXT
);
-- UNIQUE so `rank` is a real ordering. NOTE: rank is a priority, not the number
-- spoken aloud — callers renumber by position, so ranks 1/3/5 are read out as
-- "1, 2, 3". Do not assume it is dense.
CREATE UNIQUE INDEX idx_offer_impact ON offer(impact_id, rank);

-- Human in the loop. Approval is on the PLAN, before the call.
CREATE TABLE approval (
  id                     TEXT PRIMARY KEY,
  impact_id              TEXT NOT NULL REFERENCES disruption_impact(id),
  offer_id               TEXT REFERENCES offer(id),
  reason                 TEXT NOT NULL
                         CHECK (reason IN ('PLAN_REVIEW','OVER_THRESHOLD',
                                           'POLICY_FAIL','AGENT_UNSURE','MANUAL_HOLD')),
  requested_at           TEXT NOT NULL,
  decided_at             TEXT,
  decided_by             TEXT REFERENCES operator(id),
  decision               TEXT CHECK (decision IN ('APPROVED','REJECTED','MODIFIED')),
  decided_offer_id       TEXT REFERENCES offer(id),   -- set when human overrode
  note                   TEXT
);
CREATE INDEX idx_approval_pending ON approval(decided_at, impact_id);

------------------------------------------------------------------ execution

-- Split by EXECUTOR, deliberately:
--   dispatch = work VocalBridge does (a call)
--   action   = work we do (Sabre writes, non-voice notifications)

-- Slot pool. VB has NO per-call context channel, so correlation lives in the
-- tool URL path (/tools/:slot/*) and is resolved server-side from this table.
-- The LLM never handles an identifier.
CREATE TABLE agent_slot (
  slot              TEXT PRIMARY KEY,        -- 'slot-a', 'slot-b', ...
  vb_agent_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'FREE' CHECK (status IN ('FREE','BOUND')),
  -- AUTHORITATIVE for slot->dispatch resolution. `dispatch.slot` is the
  -- historical record of which slot a dispatch used; this is the live binding.
  -- Never resolve a tool call through dispatch.slot.
  -- Deliberately NO foreign key: dispatch.slot already references agent_slot,
  -- so an FK here would be circular and neither row could be inserted first.
  dispatch_id       TEXT,
  bound_at          TEXT,
  -- NULL lease is treated as UNBOUND by the resolver, so a binding that forgets
  -- to set one is a silent no-op. Enforce it instead.
  lease_expires_at  TEXT,                    -- reaper frees orphaned slots
  CHECK (status = 'FREE' OR lease_expires_at IS NOT NULL)
);

CREATE TABLE dispatch (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL
                   CHECK (kind IN ('CALL_EMPLOYEE','CALL_VENUE','CALL_NOTIFY')),
  impact_id        TEXT REFERENCES disruption_impact(id),   -- null for venue calls
  employee_id      TEXT REFERENCES employee(id),
  activity_id      TEXT,
  slot             TEXT REFERENCES agent_slot(slot),
  directive        TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  actor_kind       TEXT NOT NULL DEFAULT 'AGENT'
                   CHECK (actor_kind IN ('AGENT','COORDINATOR','CHINGU_OP','SYSTEM')),
  actor_id         TEXT REFERENCES operator(id),
  approval_id      TEXT REFERENCES approval(id),
  status           TEXT NOT NULL DEFAULT 'QUEUED'
                   CHECK (status IN ('QUEUED','DIALING','IN_CALL','RESOLVING',
                                     'RESOLVED','FAILED','NO_ANSWER')),
  call_id          TEXT,
  room_name        TEXT,                     -- == debug event session_id
  session_uuid     TEXT,                     -- the OTHER id, for /logs/{id}
  outcome_summary  TEXT,
  created_at       TEXT NOT NULL,
  resolved_at      TEXT
);
CREATE INDEX idx_dispatch_room   ON dispatch(room_name);
CREATE INDEX idx_dispatch_status ON dispatch(status);

-- Everything with an external side effect that is NOT a VB call.
CREATE TABLE action (
  id               TEXT PRIMARY KEY,
  -- ESCALATE is here so an escalation is visible to anything polling `action`.
  -- Without it, escalating shows up only as AWAITING_APPROVAL + an approval
  -- row, and a worker draining `action` never sees that a human is needed.
  kind             TEXT NOT NULL
                   CHECK (kind IN ('RESHOP','REISSUE','HOTEL_MODIFY',
                                   'VENUE_CHANGE','NOTIFY_EMAIL','NOTIFY_SMS',
                                   'ESCALATE')),
  subject_type     TEXT NOT NULL,            -- 'impact' | 'activity' | 'employee'
  subject_id       TEXT NOT NULL,
  employee_id      TEXT REFERENCES employee(id),
  dispatch_id      TEXT REFERENCES dispatch(id),
  approval_id      TEXT REFERENCES approval(id),
  actor_kind       TEXT NOT NULL DEFAULT 'AGENT',
  actor_id         TEXT REFERENCES operator(id),
  idempotency_key  TEXT NOT NULL UNIQUE,     -- never double-ticket
  request_hash     TEXT,
  attempt_no       INTEGER NOT NULL DEFAULT 1,
  state            TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (state IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  external_ref     TEXT,                     -- ticket no, confirmation id
  result_json      TEXT,                     -- venue change stores from/to here
  error            TEXT,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX idx_action_subject ON action(subject_type, subject_id);
CREATE INDEX idx_action_state   ON action(state, kind);

CREATE TABLE call_log (               -- terminal write from post-processing MCP
  id                TEXT PRIMARY KEY,
  dispatch_id       TEXT NOT NULL REFERENCES dispatch(id),
  callee            TEXT,
  phone_dialed      TEXT,
  external_call_id  TEXT,
  consent           INTEGER,
  transcript        TEXT,
  extracted_json    TEXT,
  started_at        TEXT,
  ended_at          TEXT
);
CREATE INDEX idx_calllog_dispatch ON call_log(dispatch_id);

------------------------------------------------------------------ activities

CREATE TABLE activity (               -- no Sabre equivalent
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES event(id),
  kind          TEXT NOT NULL CHECK (kind IN ('DINNER','MEETING')),
  venue         TEXT NOT NULL,
  phone         TEXT,
  address       TEXT,
  starts_at     TEXT NOT NULL,
  timezone      TEXT,
  capacity      INTEGER
);

CREATE TABLE attendance (
  id             TEXT PRIMARY KEY,
  activity_id    TEXT NOT NULL REFERENCES activity(id),
  employee_id    TEXT NOT NULL REFERENCES employee(id),
  attend_state   TEXT NOT NULL DEFAULT 'INVITED'
                 CHECK (attend_state IN ('INVITED','CONFIRMED','DECLINED','UNAVAILABLE')),
  UNIQUE (activity_id, employee_id)
  -- NOTE: whether they have been TOLD about a change is NOT here.
  -- That is a dispatch/action row. Two different axes.
);
CREATE INDEX idx_attendance_activity ON attendance(activity_id, attend_state);
