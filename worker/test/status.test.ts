import { describe, expect, test } from "bun:test";
import {
  bandFor,
  deriveStatus,
  type DispatchStatus,
  type DisplayStatus,
  type EmployeeStatus,
  type ImpactState,
} from "../src/status";

/** Every value the schema allows, so the "no state renders GREEN" test is total. */
const ALL_IMPACT_STATES: ImpactState[] = [
  "DETECTED",
  "TRIAGING",
  "AWAITING_APPROVAL",
  "CONTACTING",
  "EXECUTING",
  "RESOLVED",
  "FAILED",
];

const ALL_DISPATCH_STATUSES: DispatchStatus[] = [
  "QUEUED",
  "DIALING",
  "IN_CALL",
  "RESOLVING",
  "RESOLVED",
  "FAILED",
  "NO_ANSWER",
];

const ALL_EMPLOYEE_STATUSES: EmployeeStatus[] = ["OK", "AT_RISK", "DELAYED", "RESOLVED"];

const base = { employeeStatus: "OK" as EmployeeStatus, impactState: null, dispatchStatus: null };

describe("REGRESSION: no impact state may silently render GREEN", () => {
  // This is the P0. Commit 7dd6ba5 added EXECUTING; an earlier ladder handled
  // four states and let EXECUTING, CONTACTING and FAILED fall through to GREEN.
  // A failed rebooking showed as "on track".
  test("every impact state produces a non-GREEN status", () => {
    for (const impactState of ALL_IMPACT_STATES) {
      const status = deriveStatus({ ...base, impactState });
      expect(status, `impact state ${impactState} must not be GREEN`).not.toBe("GREEN");
    }
  });

  test("the three states that used to be GREEN map correctly", () => {
    expect(deriveStatus({ ...base, impactState: "EXECUTING" })).toBe("BOOKING");
    expect(deriveStatus({ ...base, impactState: "CONTACTING" })).toBe("CALLING");
    expect(deriveStatus({ ...base, impactState: "FAILED" })).toBe("FAILED");
  });

  test("FAILED never lands in the On track band", () => {
    expect(bandFor(deriveStatus({ ...base, impactState: "FAILED" }))).toBe("FAILED");
  });
});

describe("a live call outranks everything", () => {
  test("DIALING and IN_CALL win over any impact state", () => {
    for (const impactState of ALL_IMPACT_STATES) {
      expect(deriveStatus({ ...base, impactState, dispatchStatus: "DIALING" })).toBe("CALLING");
      expect(deriveStatus({ ...base, impactState, dispatchStatus: "IN_CALL" })).toBe("CALLING");
    }
  });
});

describe("a call that ended badly does not leave the card looking busy", () => {
  // Without this, NO_ANSWER against an impact still sitting in CONTACTING
  // renders as CALLING forever — the agent looks permanently on the phone.
  test("FAILED and NO_ANSWER surface as FAILED while the impact is unresolved", () => {
    for (const dispatchStatus of ["FAILED", "NO_ANSWER"] as DispatchStatus[]) {
      expect(deriveStatus({ ...base, impactState: "CONTACTING", dispatchStatus })).toBe("FAILED");
      expect(deriveStatus({ ...base, impactState: "TRIAGING", dispatchStatus })).toBe("FAILED");
    }
  });

  test("but a resolved impact stays resolved even if the call failed", () => {
    // The agent may have failed on a retry after the booking already landed.
    expect(
      deriveStatus({ ...base, impactState: "RESOLVED", dispatchStatus: "NO_ANSWER" }),
    ).toBe("RESOLVED");
  });
});

describe("approval is the only actionable state", () => {
  test("AWAITING_APPROVAL is the sole producer of NEEDS_YOU", () => {
    const producers = ALL_IMPACT_STATES.filter(
      (s) => deriveStatus({ ...base, impactState: s }) === "NEEDS_YOU",
    );
    expect(producers).toEqual(["AWAITING_APPROVAL"]);
  });
});

describe("structural risk with no disruption in play", () => {
  // Grace Lombardi lands past event.arrival_by; Nora Feldman has no itinerary.
  // Neither has an impact row, and both must still surface. This is what keeps
  // the calm state from being an empty screen.
  test("employee.status carries the card when there is no impact row", () => {
    expect(deriveStatus({ ...base, employeeStatus: "AT_RISK" })).toBe("AT_RISK");
    expect(deriveStatus({ ...base, employeeStatus: "DELAYED" })).toBe("AT_RISK");
    expect(deriveStatus({ ...base, employeeStatus: "RESOLVED" })).toBe("RESOLVED");
    expect(deriveStatus({ ...base, employeeStatus: "OK" })).toBe("GREEN");
  });

  test("an impact row always outranks the employee's standing status", () => {
    expect(
      deriveStatus({ employeeStatus: "AT_RISK", impactState: "RESOLVED", dispatchStatus: null }),
    ).toBe("RESOLVED");
    expect(
      deriveStatus({ employeeStatus: "OK", impactState: "FAILED", dispatchStatus: null }),
    ).toBe("FAILED");
  });
});

describe("totality", () => {
  test("no combination of the three enums throws or returns undefined", () => {
    const seen = new Set<DisplayStatus>();
    for (const employeeStatus of ALL_EMPLOYEE_STATUSES) {
      for (const impactState of [...ALL_IMPACT_STATES, null]) {
        for (const dispatchStatus of [...ALL_DISPATCH_STATUSES, null]) {
          const status = deriveStatus({ employeeStatus, impactState, dispatchStatus });
          expect(status).toBeDefined();
          expect(() => bandFor(status)).not.toThrow();
          seen.add(status);
        }
      }
    }
    // 4 x 8 x 8 = 256 combinations, and every display status is reachable.
    expect(seen.size).toBe(7);
  });

  test("GREEN requires no impact row and an OK employee", () => {
    for (const employeeStatus of ALL_EMPLOYEE_STATUSES) {
      for (const impactState of [...ALL_IMPACT_STATES, null]) {
        for (const dispatchStatus of [...ALL_DISPATCH_STATUSES, null]) {
          if (deriveStatus({ employeeStatus, impactState, dispatchStatus }) === "GREEN") {
            expect(impactState).toBeNull();
            expect(employeeStatus).toBe("OK");
          }
        }
      }
    }
  });
});

describe("bandFor", () => {
  test("maps every display status into a band", () => {
    const all: DisplayStatus[] = [
      "GREEN",
      "AT_RISK",
      "NEEDS_YOU",
      "CALLING",
      "BOOKING",
      "FAILED",
      "RESOLVED",
    ];
    for (const s of all) expect(() => bandFor(s)).not.toThrow();
  });

  test("only GREEN reaches the On track band", () => {
    const all: DisplayStatus[] = [
      "GREEN",
      "AT_RISK",
      "NEEDS_YOU",
      "CALLING",
      "BOOKING",
      "FAILED",
      "RESOLVED",
    ];
    const onTrack = all.filter((s) => bandFor(s) === "ON_TRACK");
    expect(onTrack).toEqual(["GREEN"]);
  });
});
