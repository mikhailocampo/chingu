-- Chingu — demo seed (Tier 0: local only, no Sabre calls)
--
--   wrangler d1 execute chingu --local --file=./schema.sql
--   wrangler d1 execute chingu --local --file=./seed.sql
--
-- Idempotent: deterministic ids + INSERT OR REPLACE. Re-run freely.
--
-- WHAT IS REAL vs FAKE
--   Flights  REAL. Every carrier/number/time/fare below came from live CERT
--            searches on 2026-07-18 (JFK->ICN and SFO->ICN, 2026-09-14).
--   Hotels   FAKE. CERT has ZERO Korean hotel inventory (verified: PUS 25mi
--            and ICN 30mi both return NO_HOTELS_FOUND). Plausible real
--            property, placeholder codes.
--   PNRs     FAKE. See "TIER 1" at the bottom to swap in a real ticketed PNR
--            for the one employee you actually rebook on stage.
--
-- Times are UTC. event.timezone / activity.timezone drive rendering.
-- Korea is UTC+9, so 2026-09-16T10:30:00Z == 19:30 KST.

------------------------------------------------------------------ tenancy

INSERT OR REPLACE INTO org (id, name) VALUES ('org-samsung', 'Samsung');

INSERT OR REPLACE INTO operator (id, org_id, name, email, role) VALUES
  ('op-coord',  'org-samsung', 'Hyejin Cho',  'hyejin.cho@example.com',  'COORDINATOR'),
  ('op-chingu', NULL,          'Chingu Ops',  'ops@chingu.example',      'CHINGU_OP');

-- arrival_by = 2026-09-15T15:00Z = 2026-09-16T00:00 KST (midnight before day 2).
-- UA805 lands 19:20Z on the 15th -> already in breach at seed time.
INSERT OR REPLACE INTO event
  (id, org_id, name, city, timezone, starts_at, ends_at, arrival_by, depart_after) VALUES
  ('evt-busan', 'org-samsung', 'Samsung Global Offsite', 'Busan', 'Asia/Seoul',
   '2026-09-15T00:00:00Z', '2026-09-18T09:00:00Z',
   '2026-09-15T15:00:00Z', '2026-09-18T01:00:00Z');

------------------------------------------------------------------ policy
-- Tuned against the REAL change fees found in CERT so one option set yields
-- mixed verdicts with nothing contrived:
--   $0   (DL7842 codeshare)  -> PASS
--   $100 (YP112)             -> PASS
--   $120 (OZ223 / KE82)      -> PASS
--   $200 (CX via HKG)        -> NEEDS_APPROVAL
--   $299 (UA805 basic econ)  -> NEEDS_APPROVAL

INSERT OR REPLACE INTO policy
  (id, org_id, event_id, domain, version, effective_from, currency,
   max_add_collect, cabin_max, max_nightly_rate, per_head_budget,
   requires_approval_over, rules_json) VALUES
  ('pol-flight', 'org-samsung', 'evt-busan', 'FLIGHT', 1, '2026-01-01T00:00:00Z', 'USD',
   '600.00', 'Economy', NULL, NULL, '150.00',
   '{"preferred_carriers":["KE","OZ","DL"],"max_stops":1,"max_layover_minutes":300,"refundable_required":false,"must_arrive_before_event_arrival_by":true}'),
  ('pol-hotel',  'org-samsung', 'evt-busan', 'HOTEL',  1, '2026-01-01T00:00:00Z', 'KRW',
   NULL, NULL, '320000', NULL, '150.00',
   '{"refundable_only":true,"max_distance_km_from_venue":5}'),
  ('pol-dining', 'org-samsung', 'evt-busan', 'DINING', 1, '2026-01-01T00:00:00Z', 'KRW',
   NULL, NULL, NULL, '95000', '150.00',
   '{"alcohol_allowed":true,"must_accommodate_dietary":true,"disclose_allergies_to_venue":true}');

------------------------------------------------------------------ agent slots
-- VB has no per-call context channel, so correlation lives in the tool URL
-- path and resolves through this table. Replace vb_agent_id after pool setup.

INSERT OR REPLACE INTO agent_slot (slot, vb_agent_id, status, dispatch_id, bound_at, lease_expires_at) VALUES
  ('slot-a', 'REPLACE-vb-agent-a', 'FREE', NULL, NULL, NULL),
  ('slot-b', 'REPLACE-vb-agent-b', 'FREE', NULL, NULL, NULL),
  ('slot-c', 'REPLACE-vb-agent-c', 'FREE', NULL, NULL, NULL);

------------------------------------------------------------------ employees
-- 26 total: 16 Korea-based (hotel only) + 9 US-based (flight + hotel)
--           + 1 with NO itinerary at all.

-- Korea-based (16). No flights: they are already in-country.
INSERT OR REPLACE INTO employee (id, org_id, name, email, phone_e164, home_base, timezone, dietary_json, status) VALUES
  ('emp-kr-01','org-samsung','Minjun Park',    'minjun.park@example.com',    '+821020000001','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-02','org-samsung','Seoyeon Kim',    'seoyeon.kim@example.com',    '+821020000002','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-03','org-samsung','Jihoon Lee',     'jihoon.lee@example.com',     '+821020000003','Suwon','Asia/Seoul',NULL,'OK'),
  ('emp-kr-04','org-samsung','Hyewon Jang',    'hyewon.jang@example.com',    '+821020000004','Seoul','Asia/Seoul',
     '[{"kind":"VEGETARIAN","severity":"PREFERENCE","notes":"no red meat","disclose_ok":1}]','OK'),
  ('emp-kr-05','org-samsung','Doyun Choi',     'doyun.choi@example.com',     '+821020000005','Busan','Asia/Seoul',NULL,'OK'),
  ('emp-kr-06','org-samsung','Chaewon Yoon',   'chaewon.yoon@example.com',   '+821020000006','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-07','org-samsung','Siwoo Kang',     'siwoo.kang@example.com',     '+821020000007','Daegu','Asia/Seoul',NULL,'OK'),
  ('emp-kr-08','org-samsung','Yuna Lim',       'yuna.lim@example.com',       '+821020000008','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-09','org-samsung','Jiwoo Han',      'jiwoo.han@example.com',      '+821020000009','Incheon','Asia/Seoul',NULL,'OK'),
  ('emp-kr-10','org-samsung','Eunseo Shin',    'eunseo.shin@example.com',    '+821020000010','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-11','org-samsung','Taeyang Oh',     'taeyang.oh@example.com',     '+821020000011','Ulsan','Asia/Seoul',NULL,'OK'),
  ('emp-kr-12','org-samsung','Sohee Bae',      'sohee.bae@example.com',      '+821020000012','Seoul','Asia/Seoul',
     '[{"kind":"GLUTEN","severity":"INTOLERANCE","notes":"coeliac","disclose_ok":1}]','OK'),
  ('emp-kr-13','org-samsung','Junseo Nam',     'junseo.nam@example.com',     '+821020000013','Busan','Asia/Seoul',NULL,'OK'),
  ('emp-kr-14','org-samsung','Arin Seo',       'arin.seo@example.com',       '+821020000014','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-15','org-samsung','Hyunwoo Moon',   'hyunwoo.moon@example.com',   '+821020000015','Seoul','Asia/Seoul',NULL,'OK'),
  ('emp-kr-16','org-samsung','Nayeon Gwak',    'nayeon.gwak@example.com',    '+821020000016','Gwangju','Asia/Seoul',NULL,'OK');

-- US-based (9) + 1 unbooked (10th).
-- emp-us-07 is AT_RISK at seed time: UA805 lands after event.arrival_by.
INSERT OR REPLACE INTO employee (id, org_id, name, email, phone_e164, home_base, timezone, dietary_json, status) VALUES
  ('emp-us-01','org-samsung','Jinhui Kim','daniel.whitfield@example.com','+12125550101','New York','America/New_York',NULL,'OK'),
  ('emp-us-02','org-samsung','Priya Natarajan', 'priya.natarajan@example.com', '+12125550102','New York','America/New_York',
     '[{"kind":"SHELLFISH","severity":"ALLERGY_SEVERE","notes":"anaphylaxis; carries epipen","disclose_ok":1}]','OK'),
  ('emp-us-03','org-samsung','Marcus Bell',     'marcus.bell@example.com',     '+12125550103','New York','America/New_York',NULL,'OK'),
  ('emp-us-04','org-samsung','Elena Duarte',    'elena.duarte@example.com',    '+12125550104','Newark','America/New_York',NULL,'OK'),
  ('emp-us-05','org-samsung','Tom Okafor',      'tom.okafor@example.com',      '+12125550105','Boston','America/New_York',NULL,'OK'),
  ('emp-us-06','org-samsung','Alex Rivera',     'alex.rivera@example.com',     '+14155550106','San Francisco','America/Los_Angeles',NULL,'OK'),
  ('emp-us-07','org-samsung','Grace Lombardi',  'grace.lombardi@example.com',  '+14155550107','San Francisco','America/Los_Angeles',NULL,'AT_RISK'),
  ('emp-us-08','org-samsung','Devon Clarke',    'devon.clarke@example.com',    '+14155550108','Oakland','America/Los_Angeles',NULL,'OK'),
  ('emp-us-09','org-samsung','Sofia Marchetti', 'sofia.marchetti@example.com', '+14155550109','San Jose','America/Los_Angeles',NULL,'OK'),
  -- NO ITINERARY YET. Deliberately has nothing downstream: no itinerary,
  -- no segment. Exercises the collection funnel (name -> DOB -> passport).
  ('emp-us-10','org-samsung','Nora Feldman',    'nora.feldman@example.com',    '+14155550110','Seattle','America/Los_Angeles',NULL,'AT_RISK');

------------------------------------------------------------------ flight itineraries
-- REAL flights. KE82/DL7842 are the SAME AIRCRAFT (JFK 13:10 -> ICN 17:50+1).
-- Cancelling KE82 must catch emp-us-04 too, and that only works via the
-- operating_carrier index. This is a live regression test, not decoration.

INSERT OR REPLACE INTO itinerary (id, employee_id, event_id, component, pnr, ticket_number, last_num_updates, last_synced_at, poll_status, status) VALUES
  ('itin-us-01-f','emp-us-01','evt-busan','FLIGHT','FAKE01','1800000000001',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-02-f','emp-us-02','evt-busan','FLIGHT','FAKE02','1800000000002',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-03-f','emp-us-03','evt-busan','FLIGHT','FAKE03','1800000000003',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-04-f','emp-us-04','evt-busan','FLIGHT','FAKE04','1800000000004',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-05-f','emp-us-05','evt-busan','FLIGHT','FAKE05','1800000000005',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-06-f','emp-us-06','evt-busan','FLIGHT','FAKE06','1800000000006',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-07-f','emp-us-07','evt-busan','FLIGHT','FAKE07','1800000000007',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-08-f','emp-us-08','evt-busan','FLIGHT','FAKE08','1800000000008',1,'2026-07-18T19:00:00Z','OK','TICKETED'),
  ('itin-us-09-f','emp-us-09','evt-busan','FLIGHT','FAKE09','1800000000009',1,'2026-07-18T19:00:00Z','OK','TICKETED');

-- JFK cohort. Three on marketing KE82 + one on the DL7842 codeshare = 4 affected.
INSERT OR REPLACE INTO segment
  (id, itinerary_id, type, sabre_item_id, supplier_locator, carrier, flight_no,
   operating_carrier, operating_flight_no, origin, dest,
   dep_date, dep_time_utc, arr_date, arr_time_utc, raw_status_code, status) VALUES
  ('seg-us-01','itin-us-01-f','FLIGHT','10','KEFAKE1','KE',82,'KE',82,'JFK','ICN',
     '2026-09-14','2026-09-14T17:10:00Z','2026-09-15','2026-09-15T08:50:00Z','HK','CONFIRMED'),
  ('seg-us-02','itin-us-02-f','FLIGHT','10','KEFAKE2','KE',82,'KE',82,'JFK','ICN',
     '2026-09-14','2026-09-14T17:10:00Z','2026-09-15','2026-09-15T08:50:00Z','HK','CONFIRMED'),
  ('seg-us-03','itin-us-03-f','FLIGHT','10','KEFAKE3','KE',82,'KE',82,'JFK','ICN',
     '2026-09-14','2026-09-14T17:10:00Z','2026-09-15','2026-09-15T08:50:00Z','HK','CONFIRMED'),
  -- THE CODESHARE. Marketed DL7842, flown as KE82. Same metal as the three above.
  ('seg-us-04','itin-us-04-f','FLIGHT','10','DLFAKE4','DL',7842,'KE',82,'JFK','ICN',
     '2026-09-14','2026-09-14T17:10:00Z','2026-09-15','2026-09-15T08:50:00Z','HK','CONFIRMED'),
  -- Unaffected by a KE82 cancellation.
  ('seg-us-05','itin-us-05-f','FLIGHT','10','OZFAKE5','OZ',223,'OZ',223,'JFK','ICN',
     '2026-09-14','2026-09-14T05:30:00Z','2026-09-14','2026-09-14T21:05:00Z','HK','CONFIRMED');

-- SFO cohort. Second codeshare (DL7861 flown as KE24) — present so nobody
-- "fixes" the operating_carrier match by special-casing flight 82.
INSERT OR REPLACE INTO segment
  (id, itinerary_id, type, sabre_item_id, supplier_locator, carrier, flight_no,
   operating_carrier, operating_flight_no, origin, dest,
   dep_date, dep_time_utc, arr_date, arr_time_utc, raw_status_code, status) VALUES
  ('seg-us-06','itin-us-06-f','FLIGHT','10','DLFAKE6','DL',7861,'KE',24,'SFO','ICN',
     '2026-09-14','2026-09-14T19:50:00Z','2026-09-15','2026-09-15T08:20:00Z','HK','CONFIRMED'),
  -- UA805 lands 19:20Z on the 15th, past arrival_by. AT_RISK before any disruption.
  ('seg-us-07','itin-us-07-f','FLIGHT','10','UAFAKE7','UA',805,'UA',805,'SFO','ICN',
     '2026-09-14','2026-09-15T06:45:00Z','2026-09-16','2026-09-15T19:20:00Z','HK','CONFIRMED'),
  ('seg-us-08','itin-us-08-f','FLIGHT','10','YPFAKE8','YP',112,'YP',112,'SFO','ICN',
     '2026-09-14','2026-09-15T00:00:00Z','2026-09-15','2026-09-15T12:40:00Z','HK','CONFIRMED'),
  ('seg-us-09','itin-us-09-f','FLIGHT','10','YPFAKE9','YP',112,'YP',112,'SFO','ICN',
     '2026-09-14','2026-09-15T00:00:00Z','2026-09-15','2026-09-15T12:40:00Z','HK','CONFIRMED');

------------------------------------------------------------------ hotel itineraries
-- FAKE. Real property (Park Hyatt Busan, Haeundae), placeholder codes.
-- All 25 booked travellers; emp-us-10 has none.

INSERT OR REPLACE INTO itinerary (id, employee_id, event_id, component, pnr, last_num_updates, last_synced_at, poll_status, status)
-- NB: substr(id,-2) would collide emp-kr-01 with emp-us-01. Use the cohort too.
SELECT 'itin-' || id || '-h', id, 'evt-busan', 'HOTEL',
       'HFAKE' || upper(replace(substr(id, 5), '-', '')),
       1, '2026-07-18T19:00:00Z', 'OK', 'CONFIRMED'
FROM employee
WHERE org_id = 'org-samsung' AND id <> 'emp-us-10';

INSERT OR REPLACE INTO segment
  (id, itinerary_id, type, sabre_item_id, supplier_locator, property_id, chain_code,
   property_phone, product_code, supplier_rate_code, payment_policy, num_guests,
   lead_traveler_index, check_in, check_out, free_cancel_until, raw_status_code, status)
SELECT 'seg-' || employee_id || '-h', id, 'HOTEL', '25',
       'PH' || upper(replace(substr(employee_id, 5), '-', '')),
       '900000001', 'PH', '+82-51-990-1234', 'PHBUSDLX', 'CORP', 'GUARANTEE', 1,
       1, '2026-09-15', '2026-09-18', '2026-09-11T15:00:00Z', 'HK', 'CONFIRMED'
FROM itinerary WHERE component = 'HOTEL';

------------------------------------------------------------------ dinner
-- Day 2, 19:30 KST. ALL 26 attend — including emp-us-10, who is coming to the
-- offsite even though nobody has booked her travel yet.

INSERT OR REPLACE INTO activity
  (id, event_id, kind, venue, phone, address, starts_at, timezone, capacity) VALUES
  ('act-dinner','evt-busan','DINNER','Jagalchi Hoetjip','+82-51-245-2723',
   '52 Jagalchi-ro, Jung-gu, Busan','2026-09-16T10:30:00Z','Asia/Seoul',40);

INSERT OR REPLACE INTO attendance (id, activity_id, employee_id, attend_state)
SELECT 'att-' || id, 'act-dinner', id, 'CONFIRMED'
FROM employee WHERE org_id = 'org-samsung';

-- NOTE: the venue is a seafood restaurant and emp-us-02 (Priya Natarajan) has a
-- severe shellfish allergy. That is the scenario, not an oversight.

------------------------------------------------------------------ TIER 1 (manual)
--
-- Everything above is synthetic. To do a REAL reshop+reissue on stage, one
-- employee needs a genuinely ticketed CERT PNR. Book JFK->ICN on KE82 for
-- 2026-09-14 (search-flights -> create-booking FOP CASH -> fulfill-flight-tickets),
-- then:
--
--   UPDATE itinerary SET pnr = '<REAL_PNR>', ticket_number = '<REAL_TICKET>'
--    WHERE id = 'itin-us-01-f';
--   UPDATE segment  SET supplier_locator = '<AIRLINE_LOCATOR>', sabre_item_id = '<ITEM_ID>'
--    WHERE id = 'seg-us-01';
--
-- Do NOT hardcode a PNR into this file. CERT is rebuilt periodically and
-- silently wipes bookings; a pinned locator will be dead by demo day.
