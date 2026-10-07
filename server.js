/* Spins backend: auth, saves, leaderboard, public profiles, likes.
   Persists db.json to GitHub so nothing is lost on Render restarts. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const ROOT = __dirname, DBF = path.join(ROOT, "db.json"), PORT = process.env.PORT || 3000;
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const rand = n => crypto.randomBytes(n).toString("hex");
const GHT = process.env.GITHUB_TOKEN || "", REPO = process.env.GITHUB_REPO || "", BRANCH = process.env.GITHUB_BRANCH || "main", DBFILE = "db.json";
const GH = (method, url, body) => fetch(url, { method, headers: { Authorization: "token " + GHT, Accept: "application/vnd.github.v3+json", "User-Agent": "spins", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

let ghSha = null, ghReady = false, dirty = false, pushing = false;
async function ghLoad() {
  if (!GHT || !REPO) { ghReady = true; return; }
  try {
    const r = await GH("GET", `https://api.github.com/repos/${REPO}/contents/${DBFILE}?ref=${BRANCH}`);
    if (r.ok) { const j = await r.json(); ghSha = j.sha; db = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); console.log("db loaded from GitHub"); }
    else console.log("GitHub db.json not found, starting fresh");
  } catch (e) { console.log("GitHub load failed:", e.message); }
  ghReady = true;
}
async function ghPush() {
  if (!GHT || !REPO || pushing) return; pushing = true;
  try {
    fs.writeFileSync(DBF, JSON.stringify(db));
    try { const r0 = await GH("GET", `https://api.github.com/repos/${REPO}/contents/${DBFILE}?ref=${BRANCH}`); if (r0.ok) ghSha = (await r0.json()).sha; else ghSha = null; } catch (e) {}
    const body = { message: "db save " + new Date().toISOString(), content: Buffer.from(JSON.stringify(db)).toString("base64") };
    if (ghSha) body.sha = ghSha;
    const r = await GH("PUT", `https://api.github.com/repos/${REPO}/contents/${DBFILE}`, body);
    if (r.ok) { const j = await r.json(); ghSha = j.content.sha; dirty = false; }
    else { const t = await r.text(); console.log("push failed", r.status, t.slice(0, 120)); if (r.status === 409) ghSha = null; }
  } catch (e) { console.log("push error", e.message); }
  pushing = false;
}
const loadLocal = () => { try { return JSON.parse(fs.readFileSync(DBF)); } catch (e) { return { users: {}, likes: {} }; } };
let db = loadLocal();
const flush = () => { dirty = true; try { fs.writeFileSync(DBF, JSON.stringify(db)); } catch (e) {} };
setInterval(() => { if (dirty) ghPush(); }, 4000);

const freshState = () => ({ spins: 5, inv: {}, hidden: {}, seen: {}, recent: [], stats: { spins: 0, melted: 0 }, joined: new Date().toISOString().slice(0, 10), bonus: "", coins: 0, boost: 0, avatar: "gold", own: { gold: 1 }, bio: "", auto: false, autoOn: false, likesN: 0 });
const pub = (u, a) => ({ u, joined: a.state.joined, coins: a.state.coins || 0, spinsUsed: (a.state.stats && a.state.stats.spins) || 0, melted: (a.state.stats && a.state.stats.melted) || 0, spinsLeft: a.state.spins || 0, itemsN: Object.values(a.state.inv || {}).reduce((s, n) => s + n, 0), found: Object.keys(a.state.seen || {}).length, likes: (db.likes[u] && Object.keys(db.likes[u]).length) || 0, avatar: a.state.avatar || "gold", bcol: a.state.bcol || "royal", photo: a.state.photo || null, banner: a.state.banner || null, bio: a.state.bio || "" });
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise(r => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch (e) { r({}); } }); });
const user = (req) => { const t = req.headers["authorization"] || ""; for (const u of Object.keys(db.users)) if (db.users[u].token === t && t) return { u, a: db.users[u] }; return null; };

http.createServer(async (req, res) => {
  const p = req.url.split("?")[0], q = new URL(req.url, "http://x").searchParams;
  if (!ghReady) await ghLoad();
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" }); return res.end(); }
  if (p === "/api/signup" && req.method === "POST") {
    const b = await body(req), u = String(b.u || "").toLowerCase(), pw = String(b.p || "");
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return send(res, 400, { err: "Username: 3-20 letters, numbers or _" });
    if (pw.length < 4) return send(res, 400, { err: "Password must be at least 4 characters" });
    if (db.users[u]) return send(res, 400, { err: "That username is taken. Try another." });
    const token = rand(16);
    db.users[u] = { h: sha(u + ":" + pw + ":spins"), token, state: freshState() };
    db.likes[u] = {}; flush();
    return send(res, 200, { token, state: db.users[u].state, likes: 0 });
  }
  if (p === "/api/login" && req.method === "POST") {
    const b = await body(req), u = String(b.u || "").toLowerCase(), a = db.users[u];
    if (!a || a.h !== sha(u + ":" + String(b.p || "") + ":spins")) return send(res, 400, { err: "Wrong username or password." });
    a.token = rand(16); flush();
    return send(res, 200, { token: a.token, state: a.state, likes: Object.keys(db.likes[u] || {}).length });
  }
  if (p === "/api/me") { const s = user(req); if (!s) return send(res, 401, { err: "Not logged in" }); return send(res, 200, { state: s.a.state, likes: Object.keys(db.likes[s.u] || {}).length }); }
  if (p === "/api/state" && req.method === "POST") { const s = user(req); if (!s) return send(res, 401, { err: "Not logged in" }); const b = await body(req); if (b && typeof b === "object") { s.a.state = b; s.a.state.likesN = Object.keys(db.likes[s.u] || {}).length; flush(); } return send(res, 200, { ok: 1 }); }
  if (p === "/api/leaderboard") { const list = Object.keys(db.users).map(u => pub(u, db.users[u])).sort((a, b) => b.spinsUsed - a.spinsUsed).slice(0, 200); return send(res, 200, { list }); }
  if (p === "/api/player") {
    const u = String(q.get("u") || "").toLowerCase(), a = db.users[u];
    if (!a) return send(res, 404, { err: "Player not found" });
    const me = user(req);
    const inv = Object.keys(a.state.inv || {}).filter(k => a.state.inv[k] > 0 && !(a.state.hidden || {})[k]).map(k => ({ id: k, n: a.state.inv[k] }));
    const liked = me && db.likes[u] && db.likes[u][me.u] ? true : false;
    return send(res, 200, Object.assign(pub(u, a), { inv, liked }));
  }
  if (p === "/api/like" && req.method === "POST") {
    const s = user(req); if (!s) return send(res, 401, { err: "Not logged in" });
    const b = await body(req), t = String(b.to || "").toLowerCase();
    if (!db.users[t]) return send(res, 404, { err: "Player not found" });
    if (t === s.u) return send(res, 400, { err: "You cannot like your own profile." });
    db.likes[t] = db.likes[t] || {};
    const liked = !db.likes[t][s.u];
    if (liked) db.likes[t][s.u] = 1; else delete db.likes[t][s.u];
    s.a.state.likesN = Object.keys(db.likes[s.u] || {}).length; flush();
    return send(res, 200, { likes: Object.keys(db.likes[t]).length, liked });
  }
  let fp = p === "/" ? "/index.html" : p;
  fp = path.normalize(path.join(ROOT, fp));
  if (!fp.startsWith(ROOT) || /\/(db\.json|server\.js)$/i.test(fp) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(fp).toLowerCase();
  const mime = { ".html": "text/html;charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".json": "application/json", ".ico": "image/x-icon" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log("Spins server on http://localhost:" + PORT));
