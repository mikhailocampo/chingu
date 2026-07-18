/**
 * Every response body carries a `speak` string. It is read aloud to a human,
 * never parsed — so no JSON, no ids, no codes the model would have to relay.
 *
 * A crash mid-call is worse than a graceful exit: failures are 200s with a
 * speakable instruction wherever the agent can act on them, and the two cases
 * that must stay real HTTP failures (401) still carry `speak`.
 */

export type Speakable = { speak: string } & Record<string, unknown>;

export function speak(text: string, extra: Record<string, unknown> = {}, status = 200): Response {
  return json({ speak: text, ...extra }, status);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** The graceful exit. Used for unbound slots, expired leases, terminal dispatches. */
export const NO_BOOKING = "I don't have a booking to discuss. Please end the call.";

/** 401 bodies can still reach the agent, so they must be speakable too. */
export const NOT_AUTHORISED =
  "I'm not able to access that right now. Please end the call and we'll follow up.";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CARRIERS: Record<string, string> = {
  KE: "Korean Air", OZ: "Asiana", DL: "Delta", UA: "United",
  YP: "Air Premia", CX: "Cathay Pacific", AA: "American", NH: "ANA",
};

const AIRPORTS: Record<string, string> = {
  JFK: "New York", EWR: "Newark", SFO: "San Francisco", OAK: "Oakland",
  SJC: "San Jose", BOS: "Boston", SEA: "Seattle", LAX: "Los Angeles",
  ICN: "Seoul", PUS: "Busan", GMP: "Seoul Gimpo", HKG: "Hong Kong", NRT: "Tokyo",
};

export const carrierName = (code: string | null) =>
  (code && CARRIERS[code]) || code || "your airline";

export const airportName = (code: string | null) =>
  (code && AIRPORTS[code]) || code || "";

/** "2026-09-14" -> "September 14th". Returns "" for anything unparseable. */
export function spokenDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return "";
  return `${month} ${ordinal(Number(m[3]))}`;
}

const HOUR_WORDS = [
  "twelve", "one", "two", "three", "four", "five",
  "six", "seven", "eight", "nine", "ten", "eleven",
];

const MINUTE_WORDS = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

function minuteWords(m: number): string {
  if (m < 20) return MINUTE_WORDS[m]!;
  const unit = m % 10;
  return unit === 0 ? TENS[Math.floor(m / 10)]! : `${TENS[Math.floor(m / 10)]} ${MINUTE_WORDS[unit]}`;
}

/**
 * 24h wall clock -> "seven thirty in the evening".
 *
 * Spelled out rather than left as digits: this is read aloud, and "19:30" is
 * exactly the kind of token a TTS voice renders as "nineteen thirty" to a
 * restaurant that books in twelve-hour time.
 */
export function spokenTime(hour: number, minute: number): string {
  const h = HOUR_WORDS[hour % 12]!;
  const partOfDay =
    hour < 12 ? "in the morning" : hour < 17 ? "in the afternoon" : "in the evening";
  const m =
    minute === 0 ? "o'clock"
      : minute < 10 ? `oh ${MINUTE_WORDS[minute]}`
        : minuteWords(minute);
  return `${h} ${m} ${partOfDay}`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six"];
export const countWord = (n: number) => WORDS[n] ?? String(n);

/** Routing miss. Still speakable: it can reach the agent mid-call. */
export const NO_SUCH_TOOL =
  "I can't do that right now. Please continue the conversation without it.";
