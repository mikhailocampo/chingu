"""Replay real captured VocalBridge frames through the local Worker and verify
the CallDO event log + SSE cursor-resume behave as designed."""
import json, threading, time, urllib.request, http.client

BASE = "localhost:8788"
D = "d-001"


def post(path, body):
    c = http.client.HTTPConnection(BASE, timeout=10)
    c.request("POST", path, json.dumps(body), {"Content-Type": "application/json"})
    r = c.getresponse()
    out = json.loads(r.read())
    c.close()
    return out


def get(path):
    c = http.client.HTTPConnection(BASE, timeout=10)
    c.request("GET", path)
    r = c.getresponse()
    out = json.loads(r.read())
    c.close()
    return out


def read_sse(path, cursor=None, seconds=3.0, collect=None):
    """Open an SSE stream, collect frames for `seconds`."""
    c = http.client.HTTPConnection(BASE, timeout=seconds + 5)
    hdrs = {"Accept": "text/event-stream"}
    if cursor is not None:
        hdrs["Last-Event-ID"] = str(cursor)
    c.request("GET", path, headers=hdrs)
    r = c.getresponse()
    got = []
    deadline = time.time() + seconds
    buf = b""
    while time.time() < deadline:
        try:
            chunk = r.read(1)
        except Exception:
            break
        if not chunk:
            break
        buf += chunk
        while b"\n\n" in buf:
            block, buf = buf.split(b"\n\n", 1)
            txt = block.decode(errors="replace")
            if txt.startswith(":"):
                continue
            ev = {}
            for line in txt.split("\n"):
                if line.startswith("id: "):
                    ev["id"] = int(line[4:])
                elif line.startswith("event: "):
                    ev["event"] = line[7:]
                elif line.startswith("data: "):
                    ev["data"] = json.loads(line[6:])
            if ev:
                got.append(ev)
                if collect is not None:
                    collect.append(ev)
    c.close()
    return got


print("=== 1. init dispatch ===")
print(post("/api/test/init", {"dispatchId": D, "employeeId": "E-1234", "directive": "Figure out flights"}))

print("\n=== 2. replay REAL captured VB frames ===")
real = []
for line in open("speak.jsonl"):
    d = json.loads(json.loads(line)["raw"])
    if d.get("type") == "debug_event":
        real.append(d)
for f in real:
    post("/api/test/emit", {"dispatchId": D, "kind": f["event_type"], "payload": f.get("data", {})})
print(f"replayed {len(real)} real events")
print("status:", get(f"/api/dispatch/{D}"))

print("\n=== 3. cold SSE open (no cursor) -> expect full history ===")
a = read_sse(f"/api/dispatch/{D}/stream", seconds=2.0)
print(f"received {len(a)} events, seqs {a[0]['id']}..{a[-1]['id']}")
print("kinds:", [e["event"] for e in a])

print("\n=== 4. reconnect with Last-Event-ID: 5 -> expect ONLY seq>5 ===")
b = read_sse(f"/api/dispatch/{D}/stream", cursor=5, seconds=2.0)
print(f"received {len(b)} events, seqs {[e['id'] for e in b]}")
assert all(e["id"] > 5 for e in b), "LEAK: replayed an event at or below the cursor"
print("OK: no event at or below the cursor was replayed")

print("\n=== 5. live tail: attach, then emit ===")
live = []
t = threading.Thread(target=read_sse, args=(f"/api/dispatch/{D}/stream",), kwargs={"cursor": 9999, "seconds": 5.0, "collect": live})
t.start()
time.sleep(1.5)
for i in range(3):
    post("/api/test/emit", {"dispatchId": D, "kind": "agent_response", "payload": {"text": f"live message {i}"}})
    time.sleep(0.3)
t.join()
print(f"live events received while attached: {len(live)}")
for e in live:
    print("   ", e["id"], e["event"], e["data"]["payload"])

print("\n=== 6. ordering integrity ===")
allev = read_sse(f"/api/dispatch/{D}/stream", seconds=2.0)
seqs = [e["id"] for e in allev]
print("seq count:", len(seqs), "strictly increasing:", all(x < y for x, y in zip(seqs, seqs[1:])))
print("no duplicates:", len(seqs) == len(set(seqs)))

# the pair that shares a millisecond in VB's own timestamps
pairs = [(e["event"], e["data"]["payload"].get("name")) for e in allev if e["event"] in ("tool_call", "tool_result")]
print("tool ordering preserved:", pairs)
