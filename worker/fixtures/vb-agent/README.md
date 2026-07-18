# VocalBridge agent provisioning

Everything needed to create a slot-bound agent. Nothing here is applied
automatically — creating agents is a deliberate act with a per-account cap.

## Files

| File | Purpose |
|---|---|
| `prompt-employee.md` | System prompt for `CALL_EMPLOYEE` agents |
| `prompt-venue.md` | System prompt for `CALL_VENUE` agents |
| `api-tools-employee.json` | `--api-tools-file` for an employee slot |
| `vb-frames/` | 232 captured frames from real sessions (replay source) |

## Before you can create anything

**1. A permanently stable hostname.** `api_tools[].url` is stored verbatim per
agent and the config is never rewritten per dispatch — that is the whole point
of the slot design (`VOCALBRIDGE_LEARNINGS.md:21`). A `cloudflared` **quick**
tunnel gets a fresh random hostname on every restart, so an agent created
against one is dead the moment the tunnel bounces. Use a named tunnel or a
deployed worker. Replace `REPLACE_WITH_STABLE_HOST` throughout.

**2. Per-slot bearer secrets.** `auth.type: bearer` was verified intact on
14/14 live requests with zero cross-talk between slots (`:22`). The tools worker
reads them as `SLOT_TOKEN_SLOT_A`, `SLOT_TOKEN_SLOT_B`, … (`auth.ts:12`). The
slot paths are guessable and `confirm_choice` reissues tickets, so this is
mandatory, not optional.

**3. One tools file per slot.** Correlation lives in the URL path, so slot B's
tools point at `/tools/slot-b/*`. Copy the employee file per slot and change
only the path.

## Creating a slot agent

```
vb agent create \
  --name "Chingu Slot A" \
  --style Focused \
  --prompt-file prompt-employee.md \
  --api-tools-file api-tools-employee.json \
  --deploy-targets both \
  --debug-mode true \
  --greeting "<identify the agent and include any consent or recording language your policies require>"
```

`--debug-mode true` is **required**: `IngestDO` reads the agent-scoped debug
stream, and that is the only server-side realtime source (`:9`).

## Things that will bite

- **A failed create still creates the agent.** `:24` — a `deploy_targets:
  "both"` attempt that returned a bare "Agent deployment failed" had already
  persisted a dead agent 29 seconds earlier. **Always `vb agent list` and prune
  before creating.** Otherwise the cap silently fills with corpses.
- **`deploy_targets: "both"` needs a provisioned phone number**, not just a
  paid plan (`:17`). Provisioning is a dashboard action with no CLI flag.
- **There is no templating.** `{{...}}` is read aloud, not substituted (`:19`).
- **There is no per-call context channel.** `{phone_number, participant_name}`
  is the entire accepted body of `POST /api/v1/calls` (`:19`). Everything the
  agent knows comes from `get_brief`.
- **Deleting an agent deletes its call logs**, including anything you wanted to
  keep from `/api/v1/logs` (`:24`). The frames in `vb-frames/` are already the
  only surviving copy of the earlier sessions.
- The CLI reports a **50-agent** cap; `:24` says 5. The CLI is newer — trust it,
  but prune anyway.

## Prompt design notes

Both prompts are **permanently static and slot-agnostic**. They must never be
edited per dispatch: binding a slot is a D1 `UPDATE`, never a config write.

The employee prompt leans on numbered options because `choice` is the only
LLM-supplied value in the whole design. `:20` measured the model getting an
identifier wrong 4 times out of 4 and a year wrong 3 out of 3, so a low-entropy
number heard directly is the only thing it is trusted to carry — and a slip
books a different pre-approved option for the *right* traveller rather than
someone else's trip.

The venue prompt gates dietary disclosure on `disclose_ok`. Telling a
restaurant a named guest has an allergy discloses a health fact about a real
person (`DATA_MODEL.md:181`).
