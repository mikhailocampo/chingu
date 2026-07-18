#!/usr/bin/env bash
# Generate per-slot api_tools files for `vb agent create --api-tools-file`.
#
#   ./gen-api-tools.sh https://your-host.example
#
# Writes live/api-tools-<slot>-<kind>.json. That directory is GITIGNORED
# because the files carry the per-slot bearer secrets.
#
# Why a script and not a checked-in file: `api_tools[].url` is stored verbatim
# per agent and the config is never rewritten per dispatch — that is what makes
# the slot design work (VOCALBRIDGE_LEARNINGS.md:21). A cloudflared *quick*
# tunnel gets a fresh hostname on every restart, so the URLs need regenerating
# and the agents recreating each time. With a named tunnel or a deployed
# worker you run this once.
#
# TWO undocumented traps, both found the hard way on a live call:
#
# 1. The token lives at `auth.credentials.token`, NOT at `auth.type` alone.
#    The recovered schema in VOCALBRIDGE_LEARNINGS.md:17 lists only
#    `auth:{type}` and is incomplete.
#
# 2. **VB's api_tools parser is FIELD-ORDER SENSITIVE.** Ordering the keys
#    `id, name, description, method, url, auth, parameters` caused the stored
#    `auth.credentials.token` to be silently overwritten with the DESCRIPTION
#    text, so every tool call went out as
#    `Authorization: Bearer Find out who you are speaking to...` and 401'd.
#    It also rewrote `method: POST` to `GET`. Nothing errors — `vb config set`
#    reports success and the config looks fine until a real call fails.
#    Emitting `url` and `method` BEFORE `auth` stores it correctly. Always
#    read the config back and assert the token length after setting it.
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "usage: $0 <https://public-host>" >&2
  exit 1
fi
HOST="${HOST%/}"

HERE="$(cd "$(dirname "$0")" && pwd)"
VARS="$HERE/../../../backend/workers/tools/.dev.vars"
OUT="$HERE/live"

if [ ! -f "$VARS" ]; then
  echo "missing $VARS — generate slot tokens first (see .dev.vars.example)" >&2
  exit 1
fi

mkdir -p "$OUT"

for slot in slot-a slot-b slot-c; do
  var="SLOT_TOKEN_$(echo "$slot" | tr '[:lower:]-' '[:upper:]_')"
  token="$(awk -F= -v k="$var" '$1==k{print $2}' "$VARS")"
  if [ -z "$token" ]; then
    echo "no $var in .dev.vars — skipping $slot" >&2
    continue
  fi

  # Employee agent: brief -> read numbered options -> confirm -> escalate.
  cat > "$OUT/api-tools-$slot-employee.json" <<JSON
[
  {
    "id": "get_brief",
    "name": "get_brief",
    "description": "Find out who you are speaking to and why. Call this FIRST, before saying anything substantive. Returns the traveller's name, what happened to their flight, and the numbered alternatives to read out. Takes no arguments.",
    "method": "GET",
    "url": "$HOST/tools/$slot/get_brief",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": []
  },
  {
    "id": "confirm_choice",
    "name": "confirm_choice",
    "description": "Book the alternative the traveller picked. Pass the NUMBER they chose, as read out by get_brief. Returns either a confirmation to read back, or a message saying the choice needs their coordinator's sign-off. Do not tell the traveller anything is booked until this says so.",
    "method": "POST",
    "url": "$HOST/tools/$slot/confirm_choice",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": [
      {
        "name": "choice",
        "type": "string",
        "description": "The option number the traveller chose, as they said it. A digit or a word both work: 1, \"1\", or \"one\".",
        "required": true,
        "location": "body"
      }
    ]
  },
  {
    "id": "escalate",
    "name": "escalate",
    "description": "Hand this call to a human. Use when the traveller wants none of the listed options, asks for something outside them, or you are genuinely unsure. Prefer this over improvising.",
    "method": "POST",
    "url": "$HOST/tools/$slot/escalate",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": [
      { "name": "reason", "type": "string", "description": "One short sentence on why a human is needed.", "required": true, "location": "body" }
    ]
  }
]
JSON

  # Venue agent: brief -> negotiate -> confirm the outcome.
  cat > "$OUT/api-tools-$slot-venue.json" <<JSON
[
  {
    "id": "get_brief",
    "name": "get_brief",
    "description": "Find out which venue you are calling and what needs to change. Call this FIRST, before saying anything substantive. Returns the venue, the current booking time in the venue's own timezone, the headcount, and any dietary needs you are permitted to disclose. Takes no arguments.",
    "method": "GET",
    "url": "$HOST/tools/$slot/get_brief",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": []
  },
  {
    "id": "confirm_venue",
    "name": "confirm_venue",
    "description": "Record the outcome of the venue call. Call this once the venue has clearly agreed or declined. Do not tell anyone the booking is changed until this confirms it.",
    "method": "POST",
    "url": "$HOST/tools/$slot/confirm_venue",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": [
      { "name": "agreed", "type": "boolean", "description": "True if the venue agreed to the change.", "required": true, "location": "body" },
      { "name": "new_time", "type": "string", "description": "The agreed new time in hours and minutes, e.g. \"8:15 pm\". Omit if the time did not change.", "required": false, "location": "body" },
      { "name": "note", "type": "string", "description": "One short sentence for the dashboard log.", "required": false, "location": "body" }
    ]
  },
  {
    "id": "escalate",
    "name": "escalate",
    "description": "Hand this call to a human. Use when the venue asks for something you cannot agree to, raises money, or you are genuinely unsure.",
    "method": "POST",
    "url": "$HOST/tools/$slot/escalate",
    "auth": { "type": "bearer", "credentials": { "token": "$token" } },
    "parameters": [
      { "name": "reason", "type": "string", "description": "One short sentence on why a human is needed.", "required": true, "location": "body" }
    ]
  }
]
JSON
done

echo "wrote $(ls "$OUT" | wc -l | tr -d ' ') files to $OUT for $HOST"
echo "reminder: \`vb agent list\` and prune before creating — a FAILED create still consumes a slot (VOCALBRIDGE_LEARNINGS.md:24)"
