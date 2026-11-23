#!/usr/bin/env python3
"""End-to-end API smoke test for a running server-edition container (docs/SERVER.md).

Needs a FRESH /data with a bootstrap admin (LT_ADMIN_EMAIL / LT_ADMIN_PASSWORD).
Checks sign-in, CSRF, invites, per-user isolation, path guards, admin-only commands,
disable/delete, audit; with --wav also downloads tiny.en and transcribes the file
(expects the JFK sample from whisper.cpp).

  python3 scripts/server-smoke.py --base http://127.0.0.1:8080 \
    --email admin@example.test --password '...' [--origin URL] [--wav jfk.wav]
"""
import argparse, base64, json, sys, time, urllib.request, http.cookiejar, wave, struct, re
ap = argparse.ArgumentParser()
ap.add_argument("--base", default="http://127.0.0.1:8080")
ap.add_argument("--origin", help="LT_PUBLIC_URL, when the server sets it (sent as Origin)")
ap.add_argument("--email", required=True)
ap.add_argument("--password", required=True)
ap.add_argument("--wav")
opts = ap.parse_args()
B = opts.base.rstrip("/")
ORIGIN = (opts.origin or B).rstrip("/")
class C:
    def __init__(s):
        s.j = http.cookiejar.CookieJar(); s.o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(s.j)); s.csrf = None
    def req(s, m, p, body=None, csrf=True):
        h = {"Content-Type": "application/json", "Origin": ORIGIN}
        if csrf and s.csrf: h["X-LT-CSRF"] = s.csrf
        r = urllib.request.Request(B + p, data=None if body is None else json.dumps(body).encode(), headers=h, method=m)
        try:
            with s.o.open(r) as resp: d = resp.read(); return resp.status, (json.loads(d) if d and resp.headers.get_content_type()=="application/json" else d)
        except urllib.error.HTTPError as e:
            d = e.read(); 
            try: d = json.loads(d)
            except Exception: pass
            return e.code, d
    def me(s):
        st, d = s.req("GET", "/api/me"); s.csrf = d["csrf"] if st == 200 else None; return st, d
    def inv(s, cmd, args=None): return s.req("POST", "/api/invoke/" + cmd, args or {})
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra if not cond else ""); 
    if not cond: check.fails += 1
check.fails = 0
a = C()
st, _ = a.req("POST", "/api/auth/login", {"email": opts.email, "password": "wrong"}); check("bad password rejected", st == 401, st)
st, _ = a.req("POST", "/api/auth/login", {"email": opts.email, "password": opts.password}); check("admin login", st == 200, st)
st, d = a.me(); check("admin /api/me", st == 200 and d["user"]["role"] == "admin", d)
st, _ = a.req("POST", "/api/invoke/server_db_get_all", {"store": "meetings"}, csrf=False); check("no CSRF header -> 403", st == 403, st)
st, d = a.req("POST", "/api/admin/invites", {"email": "bob@example.com", "role": "member"}); check("invite created", st == 200, d)
tok = re.search(r"invite/([^/?#]+)", d["url"]).group(1)
b = C()
st, d = b.req("POST", "/api/auth/invite/accept", {"token": tok, "name": "Bob", "password": "Bob-pass-12345"}); check("invite accepted", st == 200, d)
st, d = b.me(); check("member /api/me", st == 200 and d["user"]["role"] == "member", d)
st, _ = b.req("POST", "/api/auth/invite/accept", {"token": tok, "name": "Eve", "password": "Eve-pass-12345"}); check("invite reuse rejected", st >= 400, st)
st, _ = b.req("GET", "/api/admin/users"); check("member blocked from admin API", st == 403, st)
st, _ = b.inv("server_db_put", {"store": "meetings", "value": {"id": "m1", "title": "Bob secret", "createdAt": 1}}); check("member saves meeting", st == 200, _)
st, _ = b.inv("native_recording_write", {"request": {"meetingId": "m1", "track": "", "name": "000000.webm", "dataBase64": base64.b64encode(b"x"*100).decode()}}); check("member writes chunk", st == 200, _)
st, _ = b.inv("native_recording_write", {"request": {"meetingId": "../../x", "track": "", "name": "a", "dataBase64": ""}}); check("path traversal rejected", st == 400, st)
st, d = a.inv("server_db_get_all", {"store": "meetings"}); check("admin cannot see member meetings", st == 200 and d == [], d)
st, d = a.inv("server_db_get", {"store": "meetings", "key": "m1"}); check("admin get by id -> null", st == 200 and d is None, d)
st, d = a.inv("native_recording_list", {"meetingId": "m1"}); check("admin cannot list member recording", st == 200 and not d, d)
st, d = b.inv("native_recording_read", {"meetingId": "m1", "track": ""}); check("member reads own audio (binary)", st == 200 and isinstance(d, bytes) and len(d) == 100, (st, type(d)))
st, _ = b.inv("native_asr_download_model", {"name": "tiny.en"}); check("member cannot download models", st == 403, st)
st, _ = b.inv("native_recorder_start", {}); check("desktop-only command -> 404", st == 404, st)
if opts.wav:
    st, d = a.inv("native_asr_download_model", {"name": "tiny.en"}); check("admin downloads tiny.en", st == 200, d)
    st, d = b.inv("native_asr_models"); check("model visible to member", st == 200 and any(m.get("name") == "tiny.en" and m.get("installed") for m in d), d)
    w = wave.open(opts.wav); n = w.getnframes(); raw = w.readframes(n); sr = w.getframerate()
    pcm = struct.pack("<%df" % n, *[x / 32768 for x in struct.unpack("<%dh" % n, raw)])
    t = time.time(); st, d = b.inv("native_asr_transcribe", {"request": {"samplesBase64": base64.b64encode(pcm).decode(), "sampleRate": sr, "model": "tiny.en", "language": "en"}})
    text = " ".join(s.get("text", "") for s in d) if st == 200 else d
    check("real whisper transcription", st == 200 and "country" in text.lower(), text); print("   transcript (%.1fs): %s" % (time.time() - t, str(text).strip()))
st, d = b.req("GET", "/api/me/export"); check("member export zip", st == 200 and isinstance(d, bytes) and d[:2] == b"PK", st)
st, users = a.req("GET", "/api/admin/users"); bob = [u for u in users if u["email"] == "bob@example.com"][0]
st, _ = a.req("PATCH", "/api/admin/users/" + bob["id"], {"disabled": True}); check("admin disables member", st == 200, _)
st, _ = b.me(); check("disabled member session dropped", st == 401, st)
st, _ = a.req("PATCH", "/api/admin/users/" + [u for u in users if u["role"] == "admin"][0]["id"], {"role": "member"}); check("last admin cannot be demoted", st >= 400, st)
st, _ = a.req("DELETE", "/api/admin/users/" + bob["id"]); check("admin deletes member", st == 200 or st == 204, st)
st, d = a.req("GET", "/api/admin/audit?limit=50"); check("audit log has entries", st == 200 and len(d) > 3, st)
print("FAILS:", check.fails)
sys.exit(1 if check.fails else 0)
