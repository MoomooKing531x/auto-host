import express from "express"; import multer from "multer"; import pg from "pg"; import path from "path"; import crypto from "crypto";
const E = process.env, PORT = E.PORT || 3000, BASE = (E.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
if (!E.DATABASE_URL) throw new Error("Set DATABASE_URL");
const pool = new pg.Pool({ connectionString: E.DATABASE_URL, ssl: E.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined, max: 4 });
await pool.query("create table if not exists kv(key text primary key, value jsonb not null)");
await pool.query("create table if not exists files(name text primary key, data bytea not null)");
let db = { posts: [], tokens: {} };
{ const r = await pool.query("select value from kv where key='db'"); if (r.rows[0]) db = r.rows[0].value; }
let saving = Promise.resolve();
const save = () => { const j = JSON.stringify(db); saving = saving.then(() => pool.query("insert into kv(key,value) values('db',$1) on conflict(key) do update set value=excluded.value", [j])).catch(console.error); };
const putFile = (name, buf) => pool.query("insert into files(name,data) values($1,$2)", [name, buf]);
const getFile = async name => { const r = await pool.query("select data from files where name=$1", [name]); if (!r.rows[0]) throw new Error("file missing (was the database reset?)"); return r.rows[0].data; };
const dropFiles = async names => { const n = names.filter(Boolean); if (n.length) await pool.query("delete from files where name = any($1)", [n]); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const p of db.posts) for (const k in p.status) if (p.status[k] === "uploading") p.status[k] = "failed: interrupted, remove and re-add"; save();

const app = express();
app.get("/media/:name", async (req, res) => { // public on purpose: Instagram must fetch the video by URL
  try { const buf = await getFile(req.params.name), e = path.extname(req.params.name); res.type(e === ".jpg" ? "image/jpeg" : e === ".mov" ? "video/quicktime" : "video/mp4").send(buf); } catch { res.sendStatus(404); }
});
app.get("/health", (_, res) => res.send("ok")); // for an uptime monitor, no login
app.use((req, res, next) => {
  if (!E.APP_PASSWORD) return res.status(500).send("Set APP_PASSWORD");
  const a = Buffer.from((req.headers.authorization || "").slice(6), "base64").toString(), pw = Buffer.from(a.slice(a.indexOf(":") + 1)), want = Buffer.from(E.APP_PASSWORD);
  if (pw.length === want.length && crypto.timingSafeEqual(pw, want)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Cuetime"').status(401).send("Login required");
});
app.use(express.static("public"));

// ---------- OAuth (YouTube, TikTok) ----------
const OA = {
  youtube: { auth: "https://accounts.google.com/o/oauth2/v2/auth", tok: "https://oauth2.googleapis.com/token", idk: "client_id", id: E.GOOGLE_CLIENT_ID, secret: E.GOOGLE_CLIENT_SECRET, extra: { scope: "https://www.googleapis.com/auth/youtube.upload", access_type: "offline", prompt: "consent", response_type: "code" } },
  tiktok: { auth: "https://www.tiktok.com/v2/auth/authorize/", tok: "https://open.tiktokapis.com/v2/oauth/token/", idk: "client_key", id: E.TIKTOK_CLIENT_KEY, secret: E.TIKTOK_CLIENT_SECRET, extra: { scope: "user.info.basic,video.publish,video.upload", response_type: "code" } },
};
OA.instagram = { auth: "https://www.instagram.com/oauth/authorize", tok: "https://api.instagram.com/oauth/access_token", idk: "client_id", id: E.IG_APP_ID, secret: E.IG_APP_SECRET, extra: { scope: "instagram_business_basic,instagram_business_content_publish", response_type: "code" } };
const redirect = p => `${BASE}/auth/${p}/callback`;
app.get("/auth/:p", (req, res) => {
  const o = OA[req.params.p]; if (!o || !o.id) return res.status(400).send("Provider not configured");
  res.redirect(o.auth + "?" + new URLSearchParams({ [o.idk]: o.id, redirect_uri: redirect(req.params.p), state: "cuetime", ...o.extra }));
});
async function tokenCall(p, body) {
  const o = OA[p], r = await fetch(o.tok, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ [o.idk]: o.id, client_secret: o.secret, ...body }) });
  const j0 = await r.json(), j = j0.data?.[0] || j0; if (!j.access_token) throw new Error(`${p} token: ${JSON.stringify(j)}`);
  db.tokens[p] = { ...(db.tokens[p] || {}), ...j, at: Date.now() }; save();
}
app.get("/auth/:p/callback", async (req, res) => {
  try { await tokenCall(req.params.p, { code: req.query.code, grant_type: "authorization_code", redirect_uri: redirect(req.params.p) }); if (req.params.p === "instagram") await igLong(); res.redirect("/"); }
  catch (e) { res.status(500).send(String(e.message)); }
});
async function igLong() {
  const t = db.tokens.instagram, j = await (await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${OA.instagram.secret}&access_token=${t.access_token}`)).json();
  if (!j.access_token) throw new Error("Instagram long-lived token: " + JSON.stringify(j));
  db.tokens.instagram = { ...t, ...j, at: Date.now() }; save();
}
async function igToken() {
  const t = db.tokens.instagram; if (!t) throw new Error("instagram not connected");
  if (Date.now() > t.at + 30 * 864e5) { const j = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.access_token}`)).json(); if (j.access_token) { db.tokens.instagram = { ...t, ...j, at: Date.now() }; save(); } }
  return db.tokens.instagram;
}
app.post("/auth/:p/disconnect", (req, res) => { delete db.tokens[req.params.p]; save(); res.sendStatus(204); });
async function token(p) {
  const t = db.tokens[p]; if (!t) throw new Error(p + " not connected");
  if (Date.now() > t.at + ((t.expires_in || 3600) - 120) * 1000) await tokenCall(p, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  return db.tokens[p].access_token;
}

// ---------- Platform posters ----------
const mime = f => (f.endsWith(".mov") ? "video/quicktime" : "video/mp4");
async function yt(post, short) {
  const t = await token("youtube"), buf = await getFile(post.file);
  const r = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", "X-Upload-Content-Length": buf.length, "X-Upload-Content-Type": mime(post.file) },
    body: JSON.stringify({ snippet: { title: post.title.slice(0, 100), description: post.caption + (short ? "\n#Shorts" : ""), categoryId: "22" }, status: { privacyStatus: E.YT_PRIVACY || "public", selfDeclaredMadeForKids: false } }) });
  if (!r.ok) throw new Error("YouTube init " + r.status + " " + await r.text());
  const up = await fetch(r.headers.get("location"), { method: "PUT", headers: { "Content-Type": mime(post.file) }, body: buf });
  const v = await up.json(); if (!up.ok) throw new Error("YouTube upload " + JSON.stringify(v));
  if (post.thumbFile) {
    const th = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${v.id}&uploadType=media`, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "image/jpeg" }, body: await getFile(post.thumbFile) });
    if (!th.ok) return v.id + " (thumbnail rejected: " + th.status + ")";
  }
  return v.id;
}
async function tt(post) {
  const t = await token("tiktok"), buf = await getFile(post.file), size = buf.length;
  if (size > 64e6) throw new Error("TikTok: files over 64MB need chunked upload (not built)");
  const r = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ post_info: { title: (post.title + " " + post.caption).slice(0, 2200), privacy_level: E.TIKTOK_PRIVACY || "SELF_ONLY", video_cover_timestamp_ms: post.coverMs || 1000 }, source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 } }) });
  const j = await r.json(); if (!j.data?.upload_url) throw new Error("TikTok init " + JSON.stringify(j.error || j));
  const up = await fetch(j.data.upload_url, { method: "PUT", headers: { "Content-Type": mime(post.file), "Content-Range": `bytes 0-${size - 1}/${size}` }, body: buf });
  if (!up.ok) throw new Error("TikTok upload " + up.status);
  return j.data.publish_id;
}
async function ig(post) {
  const t = await igToken(), G = "https://graph.instagram.com/v21.0", tk = t.access_token, uid = t.user_id;
  const body = { access_token: tk, media_type: "REELS", video_url: `${BASE}/media/${post.file}`, caption: post.caption || post.title };
  if (post.thumbFile) body.cover_url = `${BASE}/media/${post.thumbFile}`;
  const j = await (await fetch(`${G}/${uid}/media`, { method: "POST", body: new URLSearchParams(body) })).json();
  if (!j.id) throw new Error("Instagram container " + JSON.stringify(j.error || j));
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const st = await (await fetch(`${G}/${j.id}?fields=status_code&access_token=${tk}`)).json();
    if (st.status_code === "FINISHED") break; if (st.status_code === "ERROR" || i === 59) throw new Error("Instagram processing " + JSON.stringify(st));
  }
  const pub = await (await fetch(`${G}/${uid}/media_publish`, { method: "POST", body: new URLSearchParams({ access_token: tk, creation_id: j.id }) })).json();
  if (!pub.id) throw new Error("Instagram publish " + JSON.stringify(pub.error || pub));
  return pub.id;
}
const POSTERS = { youtube: p => yt(p, false), ytvideo: p => yt(p, false), ytshort: p => yt(p, true), tiktok: tt, instagram: ig };

// ---------- Scheduler ----------
let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    for (const p of db.posts) for (const k in p.slots) {
      if (p.status[k] !== "queued" || Date.parse(p.slots[k]) > Date.now()) continue;
      p.status[k] = "uploading"; save();
      try { p.ids[k] = await POSTERS[k](p); p.status[k] = "posted"; } catch (e) { p.status[k] = "failed: " + String(e.message).slice(0, 240); }
      if (p.file && Object.values(p.status).every(x => x === "posted")) { await dropFiles([p.file]); p.file = ""; } // free DB space once everything is posted
      save();
    }
  } finally { busy = false; }
}
setInterval(() => tick().catch(console.error), 30000);

// ---------- API ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (Number(E.MAX_MB) || 100) * 1e6 } });
const st = k => ({ connected: !!db.tokens[k], configured: !!OA[k].id });
app.get("/api/status", async (_, res) => { const u = await pool.query("select pg_database_size(current_database()) as b").catch(() => null); res.json({ youtube: st("youtube"), tiktok: st("tiktok"), instagram: st("instagram"), usedMB: u ? Math.round(u.rows[0].b / 1e6) : null }); });
app.get("/api/posts", (_, res) => res.json(db.posts));
app.post("/api/posts", upload.single("video"), async (req, res) => {
  try {
    const m = JSON.parse(req.body.meta), id = Date.now().toString(), slots = {}, status = {};
    for (const k in m.slots) if (POSTERS[k] && k !== "youtube") { slots[k] = new Date(m.slots[k]).toISOString(); status[k] = "queued"; }
    if (!req.file || !Object.keys(slots).length) return res.status(400).json({ error: "video and platforms required" });
    let thumbFile = "";
    if (m.thumb?.startsWith("data:image/jpeg;base64,")) { thumbFile = id + ".jpg"; await putFile(thumbFile, Buffer.from(m.thumb.split(",")[1], "base64")); }
    const fname = crypto.randomBytes(12).toString("hex") + path.extname(req.file.originalname).toLowerCase(); await putFile(fname, req.file.buffer);
    db.posts.push({ id, title: String(m.title).slice(0, 100), caption: String(m.caption || ""), group: String(m.group || "Ungrouped"), file: fname, thumbFile, thumb: thumbFile ? "/media/" + thumbFile : "", coverMs: m.coverMs, slots, status, ids: {} });
    save(); res.status(201).json({ id });
  } catch (e) { res.status(400).json({ error: String(e.message) }); }
});
app.delete("/api/posts/:id", async (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id); if (!p) return res.sendStatus(404);
  await dropFiles([p.file, p.thumbFile]);
  db.posts = db.posts.filter(x => x !== p); save(); res.sendStatus(204);
});
app.listen(PORT, () => console.log("Cuetime on " + BASE));
