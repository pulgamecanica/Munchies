#!/usr/bin/env node
// Recepees gateway: the only public port.
//   /api/*  -> our API (recipe box, stock, OCR, AI, usage, admin center)
//   else    -> proxied to Ghost (theme, members, Portal, Stripe, /ghost admin)
// Same origin = the Ghost member cookie reaches us, so we ask Ghost who's logged in.
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const GHOST = process.env.GHOST_URL || 'http://ghost:2368';
const OCR = process.env.OCR_URL || 'http://ocr:8884';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LIMITS = { free: Number(process.env.FREE_AI_PER_MONTH ?? 5), paid: Number(process.env.PAID_AI_PER_MONTH ?? 200) };
const RATE = Number(process.env.API_RATE_PER_MIN) || 120;
const LANG_NAMES = { en: 'English', es: 'Spanish', fr: 'French', pt: 'Portuguese', it: 'Italian', de: 'German' };
const langOf = (l) => (LANG_NAMES[l] ? l : null);
const writeIn = (l) => (langOf(l) ? `\nWrite every human-readable text value (title, description, tags, step texts, ingredient names, notes) in ${LANG_NAMES[l]}.` : '');
const OCR_MIN_CHARS = 80; // less text than this = probably not a recipe page, let Claude look at the image instead

/* ---------- storage ---------- */
fs.mkdirSync(DATA, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'recepees.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS members (uuid TEXT PRIMARY KEY, email TEXT, stock TEXT NOT NULL DEFAULT '[]', recipes TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS usage (uuid TEXT NOT NULL, month TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uuid, month));
  CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, names TEXT NOT NULL, icon TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'admin', created INTEGER NOT NULL DEFAULT (unixepoch()));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// collections: NULL until the member's first visit, then their 3 starter collections are created in their language
const memberCols = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
if (!memberCols.includes('collections')) db.exec('ALTER TABLE members ADD COLUMN collections TEXT');
if (!memberCols.includes('bonus')) db.exec('ALTER TABLE members ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0'); // extra AI uses granted by the admin, spent after the monthly allowance
if (!memberCols.includes('created')) db.exec('ALTER TABLE members ADD COLUMN created INTEGER');
if (!memberCols.includes('trash')) db.exec("ALTER TABLE members ADD COLUMN trash TEXT NOT NULL DEFAULT '[]'"); // deleted collections/recipes, restorable
if (!memberCols.includes('prefs')) db.exec("ALTER TABLE members ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'"); // e.g. { palette: 'night' }
// analytics: one counter per day and kind of action
db.exec('CREATE TABLE IF NOT EXISTS events (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind))');

/* ---------- stock tags (global, admin-controlled) ---------- */
// Icons are inner SVG markup on a 24x24 line grid, or a full <svg>. The theme draws them as CSS masks, so they never run scripts.
const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
const cleanIcon = (raw) => {
  let svg = String(raw || '').trim();
  if (!svg.startsWith('<svg')) svg = SVG_OPEN + svg + '</svg>';
  if (svg.length > 8000 || /<script|<foreignObject|\bon\w+\s*=|javascript:|href\s*=|<!ENTITY|<style/i.test(svg)) throw fail(400, 'That icon is not a plain SVG.');
  if (!/^<svg[\s>][\s\S]*<\/svg>$/.test(svg)) throw fail(400, 'That icon is not a plain SVG.');
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
};
const TAG_ID = /^[a-z0-9][a-z0-9-]{1,30}$/;
const cleanNames = (names) => {
  const out = {};
  for (const l of ['en', 'es', 'fr', 'pt', 'it', 'de']) if (names && names[l]) out[l] = String(names[l]).slice(0, 40);
  if (!out.en) throw fail(400, 'A tag needs at least an English name.');
  return out;
};
if (!db.prepare('SELECT 1 FROM tags LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO tags (id, names, icon) VALUES (?, ?, ?)');
  try { for (const t of JSON.parse(fs.readFileSync(path.join(__dirname, 'default-tags.json'), 'utf8'))) ins.run(t.id, JSON.stringify(t.names), cleanIcon(t.icon)); } catch (e) { console.error('default tags:', e.message); }
}
const tagList = () => db.prepare('SELECT id, names, icon, source FROM tags ORDER BY created, id').all().map((t) => ({ ...t, names: JSON.parse(t.names) }));
const setting = (k, d) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? d;
const AI_TAG_MODES = ['off', 'assign', 'create'];
const aiTagMode = () => setting('ai_tags', 'assign');

/* ---------- collections (per member) ---------- */
const STARTER = {
  en: ['Favourites', 'Want to try', 'Weeknight dinners'], es: ['Favoritas', 'Por probar', 'Cenas rápidas'],
  fr: ['Favoris', 'À essayer', 'Dîners de semaine'], pt: ['Favoritas', 'Para experimentar', 'Jantares rápidos'],
  it: ['Preferite', 'Da provare', 'Cene veloci'], de: ['Favoriten', 'Ausprobieren', 'Schnelles Abendessen'],
};
const newId = (p) => p + Math.random().toString(36).slice(2, 9);
const LAYOUTS = ['stack', 'grid', 'list'];
const PALETTES = ['enamel', 'pastel', 'summer', 'night'];
// Starter collections come pre-filled from the seed recipes (2 each, rotating), so nobody opens an empty kitchen.
const seedFor = (k) => { const ids = SEED_IDS(); return ids.length ? [...new Set([ids[k % ids.length], ids[(k + 3) % ids.length]])] : []; };
const SEED_IDS = () => JSON.parse(SEED).map((r) => r.id);
let SEED = '[]';
try { SEED = JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-recipes.json'), 'utf8'))); } catch {}

const q = {
  upsert: db.prepare('INSERT INTO members (uuid, email, recipes, created) VALUES (?, ?, ?, unixepoch()) ON CONFLICT(uuid) DO UPDATE SET email = excluded.email'),
  bonus: db.prepare('SELECT bonus FROM members WHERE uuid = ?'),
  takeBonus: db.prepare('UPDATE members SET bonus = bonus - 1 WHERE uuid = ? AND bonus > 0'),
  giveBonus: db.prepare('UPDATE members SET bonus = bonus + 1 WHERE uuid = ?'),
  event: db.prepare('INSERT INTO events (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1'),
  get: db.prepare('SELECT stock, recipes FROM members WHERE uuid = ?'),
  setStock: db.prepare('UPDATE members SET stock = ? WHERE uuid = ?'),
  setRecipes: db.prepare('UPDATE members SET recipes = ? WHERE uuid = ?'),
  getCols: db.prepare('SELECT collections FROM members WHERE uuid = ?'),
  getPrefs: db.prepare('SELECT prefs FROM members WHERE uuid = ?'),
  getTrash: db.prepare('SELECT trash FROM members WHERE uuid = ?'),
  setTrash: db.prepare('UPDATE members SET trash = ? WHERE uuid = ?'),
  setPrefs: db.prepare('UPDATE members SET prefs = ? WHERE uuid = ?'),
  setCols: db.prepare('UPDATE members SET collections = ? WHERE uuid = ?'),
  used: db.prepare('SELECT used FROM usage WHERE uuid = ? AND month = ?'),
  // Atomic: only counts when under the limit, so parallel requests can't overshoot.
  take: db.prepare('INSERT INTO usage (uuid, month, used) VALUES (?, ?, 1) ON CONFLICT(uuid, month) DO UPDATE SET used = used + 1 WHERE used < ?'),
  refund: db.prepare('UPDATE usage SET used = MAX(0, used - 1) WHERE uuid = ? AND month = ?'),
  reset: db.prepare('UPDATE usage SET used = 0 WHERE uuid = ? AND month = ?'),
  admin: db.prepare(`SELECT m.uuid, m.email, m.bonus, json_array_length(m.recipes) AS recipes, json_array_length(m.stock) AS stock, COALESCE(u.used, 0) AS used
                     FROM members m LEFT JOIN usage u ON u.uuid = m.uuid AND u.month = ? ORDER BY used DESC, m.email`),
};
const month = () => new Date().toISOString().slice(0, 7);
const tierOf = (m) => (m.status === 'free' ? 'free' : 'paid'); // paid + comped
const usageOf = (m) => ({ month: month(), used: q.used.get(m.uuid, month())?.used || 0, limit: LIMITS[tierOf(m)], bonus: q.bonus.get(m.uuid)?.bonus || 0, tier: tierOf(m) });
const today = () => new Date().toISOString().slice(0, 10);
const track = (kind) => { try { q.event.run(today(), kind); } catch {} };

// Monthly allowance first, then admin-granted bonus uses. Both take/refund are single SQL statements (no overshoot).
async function withQuota(m, kind, fn) {
  const limit = LIMITS[tierOf(m)];
  let from = 'month';
  if (limit <= 0 || q.take.run(m.uuid, month(), limit).changes === 0) {
    if (q.takeBonus.run(m.uuid).changes === 0) throw fail(402, "You've used all your AI uses this month. Upgrade for more.");
    from = 'bonus';
  }
  try { const out = await fn(); track(kind); return out; }
  catch (e) { from === 'bonus' ? q.giveBonus.run(m.uuid) : q.refund.run(m.uuid, month()); throw e; }
}

/* ---------- http helpers ---------- */
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(status, { ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req, limit = 15 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(fail(413, 'Request too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(fail(400, 'Invalid JSON')); }
  });
  req.on('error', reject);
});

// Client IP: the last X-Forwarded-For hop is the one our own proxy (Traefik) added; earlier hops are client-controlled.
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;

// ponytail: in-memory fixed window per IP, fine for one gateway instance; move to Redis if you run several.
const hits = new Map();
function rateLimited(req) {
  const ip = clientIp(req), now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { if (hits.size > 50000) hits.clear(); h = { n: 0, reset: now + 60000 }; hits.set(ip, h); }
  return ++h.n > RATE;
}

/* ---------- trash ---------- */
// ponytail: capped at 500 entries (oldest dropped); add an age-based purge if storage ever matters.
function toTrash(uuid, entry) {
  const id = newId('t');
  const list = JSON.parse(q.getTrash.get(uuid)?.trash || '[]');
  q.setTrash.run(JSON.stringify([{ id, deleted: Date.now(), ...entry }, ...list].slice(0, 500)), uuid);
  return id;
}

/* ---------- members ---------- */
// Ghost staff (editors/admins) are signed in to /ghost on the same origin; only they get publishing helpers.
async function isStaff(req) {
  const cookie = req.headers.cookie || '';
  if (!cookie.includes('ghost-admin-api-session')) return false;
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const r = await fetch(GHOST + '/ghost/api/admin/users/me/', { headers: { cookie, host: req.headers.host || 'localhost', origin, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' } }).catch(() => null);
  return Boolean(r && r.ok);
}
// 30s cache per cookie: one Ghost round-trip per half minute, not per request. Plan changes show up within 30s.
const members = new Map();
async function currentMember(req) {
  const cookie = req.headers.cookie;
  if (!cookie || !cookie.includes('ghost-members-ssr')) return null;
  const hit = members.get(cookie);
  if (hit && hit.exp > Date.now()) return hit.m;
  const r = await fetch(GHOST + '/members/api/member/', {
    headers: { cookie, host: req.headers.host || 'localhost', 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' },
  }).catch(() => null);
  if (!r || r.status >= 500) throw fail(503, 'Accounts are briefly unavailable, try again in a moment.'); // don't cache an outage as "signed out"
  const data = r.ok ? await r.json().catch(() => null) : null;
  const m = data && data.uuid ? data : null;
  if (members.size > 20000) members.clear();
  members.set(cookie, { m, exp: Date.now() + 30000 });
  if (m) q.upsert.run(m.uuid, m.email, SEED);
  return m;
}

/* ---------- OCR ---------- */
// Returns '' when OCR is down/busy/empty, callers fall back to Claude vision.
async function ocr(image) {
  const m = /^data:image\/(?:jpeg|png|webp|gif);base64,(.+)$/.exec(image || '');
  if (!m) throw fail(400, 'Send a JPEG/PNG/WebP data URL as "image".');
  const r = await fetch(OCR, { method: 'POST', body: Buffer.from(m[1], 'base64'), signal: AbortSignal.timeout(60000) }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => ({})) : {};
  return (d.text || '').trim();
}

/* ---------- Claude ---------- */
async function callClaude(content, system, maxTokens = 3000) {
  if (!process.env.ANTHROPIC_API_KEY) throw fail(503, 'AI is off: set ANTHROPIC_API_KEY on the server.');
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(502, data?.error?.message || `Claude API error (${r.status})`);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}
function extractJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw fail(502, 'The AI reply had no JSON in it.');
  return JSON.parse(text.slice(s, e + 1));
}

const RECIPE_SHAPE =
  'Reply with JSON only in exactly this shape: {"title":"","emoji":"one emoji","description":"one sentence","servings":2,"time":"25 min",' +
  '"tags":["short tags"],"source":{"name":"author or site, empty if none","url":""},' +
  '"steps":[{"text":"short imperative action, e.g. Whisk, Fold together, Bake 180°C 40 min","after":[indices of earlier steps whose result this step uses],' +
  '"uses":[{"name":"ingredient","amount":number,"unit":"g|ml|tsp|tbsp|pcs|","optional":false}]}],"notes":"optional tip"}. ' +
  'This renders as a recipe table: each step combines its own "uses" plus the results of the steps in "after", and every step except the ' +
  'last must be used by exactly one later step, so everything converges into the final step. Steps with nothing to combine (preheat oven, ' +
  'grease pan) get "after":[] and "uses":[]. List each ingredient only in the step where it goes in. Prefer metric amounts.';
const RECIPE_SYSTEM = 'You turn recipes into structured recipe tables for home cooks. Reply with JSON only, no prose, no markdown fences.';
const RECOGNIZE_PROMPT =
  'List every distinct food or cooking ingredient visible (read packaging labels, which may be in French). Ignore non-food objects. ' +
  'Reply exactly as: {"items":[{"name":"lowercase English name","quantity":number,"unit":"pcs|g|ml|pack|bag|tub|bottle|",' +
  '"note":"short detail such as use-by date, or empty"}]}. Count visible units for quantity; use 1 if unsure.';

const imagePart = (image) => {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(image || '');
  if (!m) throw fail(400, 'Send a JPEG/PNG/WebP data URL as "image".');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
};
const asRecipe = (text, extra = {}) => {
  const r = extractJson(text);
  if (!r.title || !Array.isArray(r.steps)) throw fail(502, 'The AI reply was not a valid recipe.');
  return { ...r, ...extra, id: 'r' + Date.now().toString(36) };
};

// SSRF guard: public http(s) only, re-checked on every redirect.
// ponytail: DNS can change between check and fetch (rebinding); pin the IP with a custom agent if this matters.
const isPrivate = (ip) => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd]|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip);
async function fetchPage(raw) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw fail(400, 'Only http(s) links.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (!ips.length || ips.some(isPrivate)) throw fail(400, 'That link is not reachable.');
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; RecepeesBot/1.0)' }, signal: AbortSignal.timeout(15000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), u).href; continue; }
    if (!r.ok) throw fail(400, `That page answered ${r.status}.`);
    const html = (await r.text()).slice(0, 2_000_000);
    const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
    const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return { url, text: (ld ? 'Structured data:\n' + ld + '\n\nPage text:\n' : '') + text };
  }
  throw fail(400, 'Too many redirects.');
}

/* ---------- routes ---------- */
async function api(req, res, p) {
  if (p === '/api/health') return send(res, 200, { ok: true });
  if (rateLimited(req)) return send(res, 429, { error: 'Too many requests, slow down a little.' }, undefined, { 'Retry-After': '60' });

  if (p === '/api/admin' || p === '/api/admin/') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'admin.html')), 'text/html; charset=utf-8',
      { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  }
  if (p.startsWith('/api/admin/')) {
    if (!ADMIN_TOKEN || req.headers.authorization !== 'Bearer ' + ADMIN_TOKEN) throw fail(401, 'Bad admin token.');
    if (p === '/api/admin/members' && req.method === 'GET') {
      const mo = month();
      return send(res, 200, { month: mo, limits: LIMITS, members: q.admin.all(mo).map((r) => ({ ...r, usage: { [mo]: r.used } })) });
    }
    if (p === '/api/admin/tags' && req.method === 'GET') return send(res, 200, { mode: aiTagMode(), modes: AI_TAG_MODES, tags: tagList() });
    if (p === '/api/admin/settings' && req.method === 'PUT') {
      const b = await readBody(req, 4096);
      if (!AI_TAG_MODES.includes(b.ai_tags)) throw fail(400, 'Unknown AI tag mode.');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('ai_tags', b.ai_tags);
      return send(res, 200, { ok: true });
    }
    const tagM = /^\/api\/admin\/tags\/([a-z0-9-]+)$/.exec(p);
    if (tagM && req.method === 'PUT') {
      if (!TAG_ID.test(tagM[1])) throw fail(400, 'Tag ids are lowercase letters, digits and dashes.');
      const b = await readBody(req, 64 * 1024);
      db.prepare("INSERT INTO tags (id, names, icon, source) VALUES (?, ?, ?, 'admin') ON CONFLICT(id) DO UPDATE SET names = excluded.names, icon = excluded.icon, source = 'admin'")
        .run(tagM[1], JSON.stringify(cleanNames(b.names)), cleanIcon(b.icon));
      return send(res, 200, { ok: true });
    }
    if (tagM && req.method === 'DELETE') { db.prepare('DELETE FROM tags WHERE id = ?').run(tagM[1]); return send(res, 200, { ok: true }); }
    const edit = /^\/api\/admin\/members\/([a-f0-9-]+)$/i.exec(p);
    if (edit && req.method === 'PATCH') {
      // Set this month's used count and/or the bonus pool, e.g. { "bonus": 50 } to give someone 50 extra AI uses.
      const b = await readBody(req, 4096);
      const n = (v) => Math.max(0, Math.min(1e6, Math.floor(Number(v))));
      if (b.used !== undefined && Number.isFinite(Number(b.used)))
        db.prepare('INSERT INTO usage (uuid, month, used) VALUES (?, ?, ?) ON CONFLICT(uuid, month) DO UPDATE SET used = excluded.used').run(edit[1], month(), n(b.used));
      if (b.bonus !== undefined && Number.isFinite(Number(b.bonus))) db.prepare('UPDATE members SET bonus = ? WHERE uuid = ?').run(n(b.bonus), edit[1]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/stats' && req.method === 'GET') {
      const one = (sql, ...a) => Object.values(db.prepare(sql).get(...a) || { n: 0 })[0] || 0;
      const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
      return send(res, 200, {
        month: month(),
        members: one('SELECT COUNT(*) FROM members'),
        newMembers: one("SELECT COUNT(*) FROM members WHERE created >= unixepoch('now', 'start of month')"),
        recipes: one('SELECT COALESCE(SUM(json_array_length(recipes)), 0) FROM members'),
        collections: one('SELECT COALESCE(SUM(json_array_length(collections)), 0) FROM members WHERE collections IS NOT NULL'),
        stock: one('SELECT COALESCE(SUM(json_array_length(stock)), 0) FROM members'),
        aiMonth: one('SELECT COALESCE(SUM(used), 0) FROM usage WHERE month = ?', month()),
        bonusLeft: one('SELECT COALESCE(SUM(bonus), 0) FROM members'),
        tags: one('SELECT COUNT(*) FROM tags'), aiTags: one("SELECT COUNT(*) FROM tags WHERE source = 'ai'"),
        days: db.prepare('SELECT day, kind, n FROM events WHERE day >= ? ORDER BY day').all(since),
        since,
      });
    }
    const reset = /^\/api\/admin\/members\/([a-f0-9-]+)\/reset$/i.exec(p);
    if (reset && req.method === 'POST') { q.reset.run(reset[1], month()); return send(res, 200, { ok: true }); }
    throw fail(404, 'Not found');
  }

  const m = await currentMember(req);
  if (!m) throw fail(401, 'Sign in first.');
  const row = q.get.get(m.uuid);
  const stock = JSON.parse(row.stock), recipes = JSON.parse(row.recipes);

  if (p === '/api/me') {
    return send(res, 200, { member: { email: m.email, name: m.name, status: m.status }, usage: usageOf(m), ai: Boolean(process.env.ANTHROPIC_API_KEY),
      prefs: JSON.parse(q.getPrefs.get(m.uuid)?.prefs || '{}'), staff: await isStaff(req) });
  }
  if (p === '/api/prefs' && req.method === 'PUT') {
    const b = await readBody(req, 4096), prefs = JSON.parse(q.getPrefs.get(m.uuid)?.prefs || '{}');
    if (b.palette !== undefined) { if (!PALETTES.includes(b.palette)) throw fail(400, 'Unknown palette.'); prefs.palette = b.palette; }
    q.setPrefs.run(JSON.stringify(prefs), m.uuid);
    return send(res, 200, prefs);
  }

  if (p === '/api/stock' && req.method === 'GET') return send(res, 200, stock);
  if (p === '/api/stock' && req.method === 'PUT') {
    const next = await readBody(req, 512 * 1024);
    if (!Array.isArray(next)) throw fail(400, 'Stock must be an array');
    q.setStock.run(JSON.stringify(next.slice(0, 500)), m.uuid);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/tags' && req.method === 'GET') return send(res, 200, { mode: aiTagMode(), tags: tagList() });

  // Collections: [{ id, name }]. A recipe lists the collections it's in as recipe.collections = [ids].
  let cols = JSON.parse(q.getCols.get(m.uuid)?.collections || 'null');
  if (!cols) { cols = (STARTER[langOf(new URL(req.url, 'http://x').searchParams.get('lang'))] || STARTER.en).map((name) => ({ id: newId('c'), name, layout: 'stack', starter: true })); q.setCols.run(JSON.stringify(cols), m.uuid); }
  if (cols.some((c, k) => k < 3 && !c.seeded)) {
    // Fill each starter collection with default recipes once (also for accounts created before this existed).
    const have = new Set(recipes.map((r) => r.id)), seed = JSON.parse(SEED);
    cols = cols.map((c, k) => {
      if (k >= 3 || c.seeded) return c;
      const empty = !recipes.some((r) => (r.collections || []).includes(c.id));
      if (empty) for (const id of seedFor(k)) {
        if (!have.has(id)) { const sr = seed.find((x) => x.id === id); if (sr) { recipes.push({ ...sr }); have.add(id); } }
        const r = recipes.find((x) => x.id === id);
        if (r) r.collections = [...new Set([...(r.collections || []), c.id])];
      }
      return { ...c, seeded: true, cover: c.cover || seedFor(k)[0] || '' };
    });
    q.setCols.run(JSON.stringify(cols), m.uuid);
    q.setRecipes.run(JSON.stringify(recipes), m.uuid);
  }
  if (p === '/api/collections' && req.method === 'GET') return send(res, 200, cols);
  if (p === '/api/collections' && req.method === 'POST') {
    const name = String((await readBody(req, 4096)).name || '').trim().slice(0, 60);
    if (!name) throw fail(400, 'Give the collection a name.');
    if (cols.length >= 50) throw fail(400, 'That is the maximum number of collections.');
    const c = { id: newId('c'), name, layout: 'stack', seeded: true };
    q.setCols.run(JSON.stringify([...cols, c]), m.uuid);
    return send(res, 200, c);
  }
  const colM = /^\/api\/collections\/(c[a-z0-9]+)$/.exec(p);
  if (colM && req.method === 'PATCH') {
    // Collection settings: name, layout (stack | grid | list), hidden, cover recipe, move (-1 / 1 to reorder).
    const b = await readBody(req, 4096), i = cols.findIndex((c) => c.id === colM[1]);
    if (i < 0) throw fail(404, 'Not found');
    const c = { ...cols[i] };
    if (b.name !== undefined) { c.name = String(b.name).trim().slice(0, 60); if (!c.name) throw fail(400, 'Give the collection a name.'); }
    if (b.layout !== undefined) { if (!LAYOUTS.includes(b.layout)) throw fail(400, 'Unknown layout.'); c.layout = b.layout; }
    if (b.hidden !== undefined) c.hidden = Boolean(b.hidden);
    if (b.cover !== undefined) c.cover = recipes.some((r) => r.id === b.cover) ? b.cover : '';
    cols[i] = c;
    const j = i + (b.move === -1 ? -1 : b.move === 1 ? 1 : 0);
    if (j !== i && j >= 0 && j < cols.length) [cols[i], cols[j]] = [cols[j], cols[i]];
    q.setCols.run(JSON.stringify(cols), m.uuid);
    return send(res, 200, cols);
  }
  if (colM && req.method === 'DELETE') {
    // Into the trash with the list of recipes it held, so a restore puts everything back.
    const c = cols.find((x) => x.id === colM[1]);
    if (!c) throw fail(404, 'Not found');
    const held = recipes.filter((r) => (r.collections || []).includes(c.id)).map((r) => r.id);
    const tid = toTrash(m.uuid, { type: 'collection', item: c, recipes: held });
    q.setCols.run(JSON.stringify(cols.filter((x) => x.id !== c.id)), m.uuid);
    q.setRecipes.run(JSON.stringify(recipes.map((r) => ({ ...r, collections: (r.collections || []).filter((id) => id !== c.id) }))), m.uuid);
    return send(res, 200, { ok: true, trash: tid });
  }

  // Trash: [{ id, type: 'collection' | 'recipe', item, recipes?, deleted }]. Kept until restored or deleted for good.
  const trash = JSON.parse(q.getTrash.get(m.uuid)?.trash || '[]');
  if (p === '/api/trash' && req.method === 'GET') return send(res, 200, trash);
  if (p === '/api/trash' && req.method === 'DELETE') { q.setTrash.run('[]', m.uuid); return send(res, 200, { ok: true }); }
  const trM = /^\/api\/trash\/(t[a-z0-9]+)(\/restore)?$/.exec(p);
  if (trM) {
    const entry = trash.find((x) => x.id === trM[1]);
    if (!entry) throw fail(404, 'That item is no longer in the trash.');
    q.setTrash.run(JSON.stringify(trash.filter((x) => x.id !== entry.id)), m.uuid);
    if (req.method === 'DELETE' && !trM[2]) return send(res, 200, { ok: true });
    if (req.method !== 'POST' || !trM[2]) throw fail(404, 'Not found');
    if (entry.type === 'recipe') {
      q.setRecipes.run(JSON.stringify([...recipes.filter((r) => r.id !== entry.item.id), { ...entry.item, collections: (entry.item.collections || []).filter((id) => cols.some((c) => c.id === id)) }]), m.uuid);
    } else {
      const c = cols.some((x) => x.id === entry.item.id) ? { ...entry.item, id: newId('c') } : entry.item;
      q.setCols.run(JSON.stringify([...cols, c]), m.uuid);
      const held = new Set(entry.recipes || []);
      q.setRecipes.run(JSON.stringify(recipes.map((r) => (held.has(r.id) ? { ...r, collections: [...new Set([...(r.collections || []), c.id])] } : r))), m.uuid);
    }
    return send(res, 200, { ok: true, type: entry.type });
  }

  if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, recipes);
  if (p === '/api/recipes' && req.method === 'POST') {
    const r = await readBody(req, 512 * 1024);
    if (!r.title || !Array.isArray(r.steps)) throw fail(400, 'Invalid recipe');
    r.id = String(r.id || 'r' + Date.now().toString(36)).slice(0, 80);
    r.collections = [...new Set((Array.isArray(r.collections) ? r.collections : []).filter((id) => cols.some((c) => c.id === id)))];
    q.setRecipes.run(JSON.stringify([...recipes.filter((x) => x.id !== r.id), r].slice(-1000)), m.uuid);
    return send(res, 200, r);
  }
  if (p.startsWith('/api/recipes/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.split('/').pop());
    const r = recipes.find((x) => x.id === id);
    if (!r) throw fail(404, 'Not found');
    const tid = toTrash(m.uuid, { type: 'recipe', item: r });
    q.setRecipes.run(JSON.stringify(recipes.filter((x) => x.id !== id)), m.uuid);
    return send(res, 200, { ok: true, trash: tid });
  }

  if (req.method !== 'POST') throw fail(404, 'Not found');
  const body = await readBody(req);

  if (p === '/api/ocr') {
    // Free (not metered): plain text from a photo, so anyone can edit it before making a table.
    const text = await ocr(body.image);
    if (!text) throw fail(422, 'Could not read any text in that photo.');
    track('ocr');
    return send(res, 200, { text });
  }
  if (p === '/api/recognize') {
    const img = imagePart(body.image);
    const tags = aiTagMode() === 'off' ? [] : tagList();
    const prompt = RECOGNIZE_PROMPT + (langOf(body.lang) ? ` Write names and notes in ${LANG_NAMES[body.lang]} instead of English.` : '') +
      (tags.length ? ` Also give each item a "tag": the best id from ${JSON.stringify(tags.map((t) => ({ id: t.id, name: t.names.en })))}, or "" if none fits.` : '');
    const items = await withQuota(m, 'recognize', async () => extractJson(await callClaude([img, { type: 'text', text: prompt }], 'You identify food in photos for a kitchen stock tracker. Reply with JSON only.', 1200)).items);
    const ids = new Set(tags.map((t) => t.id));
    return send(res, 200, { items: (Array.isArray(items) ? items : []).map((it) => ({ ...it, tag: ids.has(it.tag) ? it.tag : '' })) });
  }
  if (p === '/api/stock/sort') {
    // AI sorts the member's stock into the admin's tags; in "create" mode it may add new tags, icon included.
    const mode = aiTagMode();
    if (mode === 'off') throw fail(403, 'Sorting with AI is turned off.');
    const items = stock.map((s, i) => ({ i, name: s.name, note: s.note || '' })).filter((x, i) => body.all || !stock[i].tag);
    if (!items.length) return send(res, 200, { stock, created: [] });
    const tags = tagList();
    const prompt = `Kitchen stock items: ${JSON.stringify(items.slice(0, 200))}\nTags: ${JSON.stringify(tags.map((t) => ({ id: t.id, name: t.names.en })))}\n` +
      'Give every item exactly one tag id. ' + (mode === 'create'
        ? 'If no tag fits an item, create a new tag and use its id. Create as few new tags as possible, only for a real food category. A new tag is ' +
          '{"id":"kebab-case english","names":{"en":"","es":"","fr":"","pt":"","it":"","de":""},"icon":"inner SVG for a 24x24 viewBox: a simple line icon of the category made of <path>, <circle>, <ellipse> or <rect> elements only, no fills, no text"}. '
        : 'Use only these tag ids; if none fits, use "". ') +
      'Reply with JSON only: {"assign":[{"i":0,"tag":"id"}],"new":[]}';
    const out = await withQuota(m, 'sort', async () => extractJson(await callClaude(prompt, 'You organise a kitchen stock into categories. Reply with JSON only.', 4000)));
    const created = [];
    if (mode === 'create') {
      const ins = db.prepare("INSERT OR IGNORE INTO tags (id, names, icon, source) VALUES (?, ?, ?, 'ai')");
      for (const t of (out.new || []).slice(0, 5)) {
        try { if (TAG_ID.test(t.id)) { ins.run(t.id, JSON.stringify(cleanNames(t.names)), cleanIcon(t.icon)); created.push(t.id); } } catch {}
      }
    }
    const ids = new Set(tagList().map((t) => t.id));
    for (const a of out.assign || []) if (stock[a.i] && ids.has(a.tag)) stock[a.i].tag = a.tag;
    q.setStock.run(JSON.stringify(stock), m.uuid);
    return send(res, 200, { stock, created });
  }
  if (p === '/api/generate') {
    const ing = (body.ingredients || []).map(String).slice(0, 80);
    if (!ing.length) throw fail(400, 'Pick at least one ingredient.');
    const prompt = `Create one recipe using mainly these ingredients: ${ing.join(', ')}.\n` +
      (body.notes ? `Preferences: ${String(body.notes).slice(0, 500)}\n` : '') +
      'Assume salt, pepper, oil and water are available; anything else not listed is optional or minimal.\n' + RECIPE_SHAPE + writeIn(body.lang);
    return send(res, 200, await withQuota(m, 'generate', async () => asRecipe(await callClaude(prompt, RECIPE_SYSTEM), { generated: true, lang: langOf(body.lang) || undefined })));
  }
  if (p === '/api/convert') {
    // "Make a table": from a link, pasted text, or a photo of a cookbook page (OCR first, vision as fallback).
    let content, source = {};
    if (body.image) {
      const text = await ocr(body.image);
      content = text.length >= OCR_MIN_CHARS
        ? `Convert this recipe. It was OCR'd from a cookbook photo, so fix obvious OCR mistakes.\n${RECIPE_SHAPE}\n\n${text.slice(0, 30000)}`
        : [imagePart(body.image), { type: 'text', text: 'Convert the recipe in this photo.\n' + RECIPE_SHAPE }];
    } else if (body.url) {
      const page = await fetchPage(String(body.url));
      source = { url: page.url };
      content = `Convert the recipe on this page (source ${page.url}).\n${RECIPE_SHAPE}\n\n${page.text.slice(0, 60000)}`;
    } else if (body.text) content = `Convert this recipe.\n${RECIPE_SHAPE}\n\n${String(body.text).slice(0, 30000)}`;
    else throw fail(400, 'Send a url, text or image.');
    const extra = writeIn(body.lang);
    if (typeof content === 'string') content += extra; else content[1].text += extra;
    return send(res, 200, await withQuota(m, 'convert', async () => {
      const r = asRecipe(await callClaude(content, RECIPE_SYSTEM, 4000), { lang: langOf(body.lang) || undefined });
      return { ...r, source: { ...(r.source || {}), ...source } };
    }));
  }
  if (p === '/api/translate') {
    const r = body.recipe, l = langOf(body.lang);
    if (!l) throw fail(400, 'Unsupported language.');
    if (!r || !r.title || !Array.isArray(r.steps)) throw fail(400, 'Invalid recipe');
    const { id, source, lang, ...text } = r;
    const prompt = `Translate this recipe JSON into ${LANG_NAMES[l]}. Translate title, description, tags, every steps[].text, every steps[].uses[].name and notes. ` +
      'Keep every other key, number, unit, emoji and the "after" arrays exactly as they are. Reply with the full JSON only.\n\n' + JSON.stringify(text).slice(0, 60000);
    return send(res, 200, await withQuota(m, 'translate', async () => ({ ...asRecipe(await callClaude(prompt, RECIPE_SYSTEM, 4000)), id: `${id || 'r'}-${l}`, source, lang: l })));
  }
  throw fail(404, 'Not found');
}

function proxy(req, res) {
  const headers = { ...req.headers, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' };
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  const up = http.request(GHOST + req.url, { method: req.method, headers }, (r) => {
    // ponytail: no CSP on Ghost pages (Portal, Stripe, admin load third-party scripts); add one per path if you lock it down.
    const extra = headers['x-forwarded-proto'] === 'https' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {};
    res.writeHead(r.statusCode, { ...SECURITY, ...extra, ...r.headers });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'Ghost is starting up, refresh in a few seconds.', 'text/plain'); else res.destroy(); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith('/api/')) return proxy(req, res);
  try { await api(req, res, p); }
  catch (e) { if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' }); if (!e.status) console.error(e); }
});
server.headersTimeout = 20000;
server.requestTimeout = 120000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Recepees gateway on :${PORT} -> Ghost ${GHOST}, OCR ${OCR} | AI ${process.env.ANTHROPIC_API_KEY ? 'on (' + MODEL + ')' : 'off'} | admin ${ADMIN_TOKEN ? 'on' : 'off (set ADMIN_TOKEN)'}`);
});
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
