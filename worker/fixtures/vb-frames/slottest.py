"""Slot-bound agent pool test.

Runs sessions against one or more agents concurrently, each with its own
agent-scoped debug listener, and records the exact ordering of tool_call vs
agent_response so we can measure whether the model reliably leads with
get_brief instead of improvising.

Usage: python slottest.py <outprefix> <reps> <agent_id:label> [<agent_id:label> ...]
"""
import asyncio, json, sys, time, pathlib, urllib.request, wave

HOME = pathlib.Path.home()
KEY = json.loads((HOME / ".vocal-bridge" / "config.json").read_text())["api_key"]
BASE = "https://vocalbridgeai.com"

OUT = sys.argv[1]
REPS = int(sys.argv[2])
AGENTS = [a.split(":", 1) for a in sys.argv[3:]]  # [(agent_id, label), ...]

T0 = time.time()
el = lambda: round(time.time() - T0, 3)
frames = []          # every debug frame, tagged with which agent's stream it came from
sessions = []        # token responses


def post(path, body, agent):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"X-API-Key": KEY, "X-Agent-Id": agent,
                 "Content-Type": "application/json", "User-Agent": "curl/8.7.1"},
        method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def load(path):
    w = wave.open(path)
    return w.readframes(w.getnframes())


UTT_A = load("uttA.wav")
UTT_B = load("uttB.wav")


async def listen(agent, label, stop):
    import websockets
    tok = post("/api/v1/debug/token", {}, agent)
    async with websockets.connect(tok["ws_url"], ping_interval=20) as ws:
        print(f"[{el():7.3f}] WS[{label}] connected", flush=True)
        while not stop.is_set():
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except Exception:
                break
            d = json.loads(raw)
            if d.get("type") != "debug_event":
                continue
            frames.append({"t": el(), "stream": label, "agent": agent, "ev": d})
            et = d.get("event_type")
            data = d.get("data") or {}
            peek = ""
            if et == "tool_call":
                peek = f" -> {data.get('name')} args={data.get('arguments')}"
            elif et == "tool_result":
                r = str(data.get("result", ""))[:80]
                peek = f" -> {data.get('name')} is_error={data.get('is_error')} {r!r}"
            elif et in ("agent_response", "user_transcription"):
                peek = " " + repr(str(data.get("text") or data.get("transcript"))[:95])
            print(f"[{el():7.3f}] [{label}] {et}{peek}", flush=True)


async def run_session(agent, label, rep):
    from livekit import rtc
    tag = f"{label}#{rep}"
    tk = post("/api/v1/token", {"participant_name": f"traveller-{tag}"}, agent)
    sessions.append({"tag": tag, "agent": agent, "label": label,
                     "room_name": tk["room_name"]})
    print(f"[{el():7.3f}] {tag} room={tk['room_name'][-12:]}", flush=True)

    room = rtc.Room()
    await room.connect(tk["livekit_url"], tk["token"])
    src = rtc.AudioSource(48000, 1)
    track = rtc.LocalAudioTrack.create_audio_track("mic", src)
    await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))

    SPC, B = 480, 960
    sil = b"\x00" * B

    async def push(chunks):
        for c in chunks:
            await src.capture_frame(rtc.AudioFrame(
                data=c, sample_rate=48000, num_channels=1, samples_per_channel=SPC))
            await asyncio.sleep(0.01)

    def frames_of(pcm):
        return [pcm[i:i + B].ljust(B, b"\x00") for i in range(0, len(pcm), B)]

    await push([sil] * 800)            # ~8s: greeting + time to call get_brief
    await push(frames_of(UTT_A))       # "Hello? Yes, speaking. What's this about?"
    await push([sil] * 1600)           # ~16s to answer
    await push(frames_of(UTT_B))       # "let's go with the first option"
    await push([sil] * 1200)           # ~12s
    await room.disconnect()
    print(f"[{el():7.3f}] {tag} disconnected", flush=True)


async def main():
    stop = asyncio.Event()
    listeners = [asyncio.create_task(listen(a, l, stop)) for a, l in AGENTS]
    await asyncio.sleep(2.5)

    for rep in range(1, REPS + 1):
        print(f"\n[{el():7.3f}] ===== REP {rep} =====", flush=True)
        await asyncio.gather(*[run_session(a, l, rep) for a, l in AGENTS])
        await asyncio.sleep(6)

    await asyncio.sleep(8)
    stop.set()
    await asyncio.sleep(1.5)
    for t in listeners:
        t.cancel()

    with open(f"{OUT}.jsonl", "w") as fh:
        for f in frames:
            fh.write(json.dumps(f) + "\n")
    with open(f"{OUT}.sessions.json", "w") as fh:
        json.dump(sessions, fh, indent=2)
    print(f"\nWROTE {len(frames)} frames, {len(sessions)} sessions", flush=True)


asyncio.run(main())
