import { describe, expect, test } from "bun:test";
import {
  assertDialable,
  isDialable,
  NotAllowlisted,
  parseAllowlist,
  redactPhone,
} from "../src/allowlist";

/**
 * A stand-in for the real allowlisted number, which lives ONLY in
 * worker/.dev.vars (gitignored). This repo is public — never inline a personal
 * number in source or tests. +1212555xxxx is the reserved fictional range.
 */
const ALLOWED = "+12125550199";

/** Numbers seed.sql actually ships. These must never dial. */
const SEED_KR = "+821020000001";
const SEED_US = "+12125550101";

describe("fail closed", () => {
  test("empty allowlist refuses everything, including a valid number", () => {
    expect(() => assertDialable(ALLOWED, {})).toThrow(NotAllowlisted);
    expect(() => assertDialable(ALLOWED, { DIAL_ALLOWLIST: "" })).toThrow(
      /outbound dialing is disabled/,
    );
  });

  test("a number absent from a non-empty list is refused", () => {
    expect(() => assertDialable(SEED_KR, { DIAL_ALLOWLIST: ALLOWED })).toThrow(
      /not on DIAL_ALLOWLIST/,
    );
  });

  test("null and undefined phones are refused, not passed through", () => {
    expect(() => assertDialable(null, { DIAL_ALLOWLIST: ALLOWED })).toThrow(
      /no phone number/,
    );
    expect(() => assertDialable(undefined, { DIAL_ALLOWLIST: ALLOWED })).toThrow(
      /no phone number/,
    );
  });
});

describe("the seed fan-out cannot reach strangers", () => {
  // The whole point of this module. VOCALBRIDGE_LEARNINGS.md:11 confirms
  // outbound is real once Pilot is live; seed.sql ships 16 Korean numbers in a
  // non-reserved range.
  test("no seed number is dialable when only one number is allowlisted", () => {
    const env = { DIAL_ALLOWLIST: ALLOWED };
    const seedNumbers = [
      SEED_KR,
      "+821020000002",
      "+821020000016",
      SEED_US,
      "+14155550107",
    ];
    for (const n of seedNumbers) {
      expect(isDialable(n, env)).toBe(false);
    }
    expect(isDialable(ALLOWED, env)).toBe(true);
  });

  test("555 numbers get no special treatment — enumeration, not heuristics", () => {
    // A 'looks fictional so it's safe' shortcut is exactly the bug this avoids.
    // SEED_US is itself a 555 number and is still refused.
    expect(isDialable(SEED_US, { DIAL_ALLOWLIST: ALLOWED })).toBe(false);
  });
});

describe("shape validation precedes membership", () => {
  test("malformed numbers report their shape, not their membership", () => {
    const env = { DIAL_ALLOWLIST: ALLOWED };
    expect(() => assertDialable("2125550199", env)).toThrow(/not a valid E.164/);
    expect(() => assertDialable("+0125550199", env)).toThrow(/not a valid E.164/);
    expect(() => assertDialable("+1-212-555-0199", env)).toThrow(/not a valid E.164/);
  });

  test("a malformed number is refused even if it is on the list verbatim", () => {
    expect(() => assertDialable("555", { DIAL_ALLOWLIST: "555" })).toThrow(
      /not a valid E.164/,
    );
  });
});

describe("parseAllowlist", () => {
  test("handles whitespace, blanks and trailing commas", () => {
    const s = parseAllowlist(` ${ALLOWED} , ,+14155550199,`);
    expect(s.size).toBe(2);
    expect(s.has(ALLOWED)).toBe(true);
    expect(s.has("+14155550199")).toBe(true);
  });

  test("unset or empty yields an empty set", () => {
    expect(parseAllowlist(undefined).size).toBe(0);
    expect(parseAllowlist(null).size).toBe(0);
    expect(parseAllowlist("   ").size).toBe(0);
  });
});

describe("redactPhone", () => {
  test("keeps country code and last two digits only", () => {
    const r = redactPhone(ALLOWED);
    expect(r).toStartWith("+1");
    expect(r).toEndWith("99");
    expect(r).toHaveLength(ALLOWED.length); // same width, no length leak either way
    expect(r).not.toContain("2125550");
    expect(r.replace(/\*/g, "")).toBe("+199"); // everything between is masked
  });

  test("does not leak short or empty input", () => {
    expect(redactPhone("")).toBe("***");
    expect(redactPhone("+1")).toBe("***");
  });

  test("error messages never contain the full number", () => {
    try {
      assertDialable(SEED_KR, { DIAL_ALLOWLIST: ALLOWED });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(SEED_KR);
      expect((err as Error).message).toContain("not on DIAL_ALLOWLIST");
    }
  });
});
