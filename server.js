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
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const GHOST = process.env.GHOST_URL || 'http://ghost:2368';
const OCR = process.env.OCR_URL || 'http://ocr:8884';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LIMITS = { free: Number(process.env.FREE_AI_PER_MONTH ?? 5), paid: Number(process.env.PAID_AI_PER_MONTH ?? 200) };
const RATE = Number(process.env.API_RATE_PER_MIN) || 120;
// Per-feature monthly caps on top of the general AI allowance, by plan.
const FEATURE_LIMITS = { sort: { free: Number(process.env.SORT_FREE_PER_MONTH ?? 3), paid: Number(process.env.SORT_PAID_PER_MONTH ?? 30) } };
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
if (!memberCols.includes('daily')) db.exec('ALTER TABLE members ADD COLUMN daily TEXT'); // { date, recipe, claimed }
if (!memberCols.includes('seen')) db.exec("ALTER TABLE members ADD COLUMN seen TEXT NOT NULL DEFAULT '[]'"); // every ingredient name ever in stock
if (!memberCols.includes('prefs')) db.exec("ALTER TABLE members ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'"); // e.g. { palette: 'night' }
// analytics: one counter per day and kind of action
db.exec('CREATE TABLE IF NOT EXISTS feature_usage (uuid TEXT NOT NULL, month TEXT NOT NULL, kind TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uuid, month, kind))');
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
const dailyJobs = new Map(); // one generation in flight per member
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
  fUsed: db.prepare('SELECT used FROM feature_usage WHERE uuid = ? AND month = ? AND kind = ?'),
  fTake: db.prepare('INSERT INTO feature_usage (uuid, month, kind, used) VALUES (?, ?, ?, 1) ON CONFLICT(uuid, month, kind) DO UPDATE SET used = used + 1 WHERE used < ?'),
  fRefund: db.prepare('UPDATE feature_usage SET used = MAX(0, used - 1) WHERE uuid = ? AND month = ? AND kind = ?'),
  event: db.prepare('INSERT INTO events (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1'),
  get: db.prepare('SELECT stock, recipes FROM members WHERE uuid = ?'),
  setStock: db.prepare('UPDATE members SET stock = ? WHERE uuid = ?'),
  setRecipes: db.prepare('UPDATE members SET recipes = ? WHERE uuid = ?'),
  getCols: db.prepare('SELECT collections FROM members WHERE uuid = ?'),
  getPrefs: db.prepare('SELECT prefs FROM members WHERE uuid = ?'),
  getTrash: db.prepare('SELECT trash FROM members WHERE uuid = ?'),
  getDaily: db.prepare('SELECT daily FROM members WHERE uuid = ?'),
  setDaily: db.prepare('UPDATE members SET daily = ? WHERE uuid = ?'),
  getSeen: db.prepare('SELECT seen FROM members WHERE uuid = ?'),
  setSeen: db.prepare('UPDATE members SET seen = ? WHERE uuid = ?'),
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
const usageOf = (m) => ({ month: month(), used: q.used.get(m.uuid, month())?.used || 0, limit: LIMITS[tierOf(m)], bonus: q.bonus.get(m.uuid)?.bonus || 0, tier: tierOf(m),
  features: Object.fromEntries(Object.entries(FEATURE_LIMITS).map(([k, l]) => [k, { used: q.fUsed.get(m.uuid, month(), k)?.used || 0, limit: l[tierOf(m)] }])) });
const today = () => new Date().toISOString().slice(0, 10);
const track = (kind) => { try { q.event.run(today(), kind); } catch {} };

// Monthly allowance first, then admin-granted bonus uses. Both take/refund are single SQL statements (no overshoot).
async function withQuota(m, kind, fn) {
  const limit = LIMITS[tierOf(m)];
  const cap = FEATURE_LIMITS[kind] && FEATURE_LIMITS[kind][tierOf(m)];
  if (cap !== undefined && (cap <= 0 || q.fTake.run(m.uuid, month(), kind, cap).changes === 0))
    throw fail(402, tierOf(m) === 'free' ? "You've used this month's AI sorts on the free plan. Upgrade for more." : "You've used all of this month's AI sorts.");
  const giveBack = () => { if (cap !== undefined) q.fRefund.run(m.uuid, month(), kind); };
  let from = 'month';
  if (limit <= 0 || q.take.run(m.uuid, month(), limit).changes === 0) {
    if (q.takeBonus.run(m.uuid).changes === 0) { giveBack(); throw fail(402, "You've used all your AI uses this month. Upgrade for more."); }
    from = 'bonus';
  }
  try { const out = await fn(); track(kind); return out; }
  catch (e) { from === 'bonus' ? q.giveBonus.run(m.uuid) : q.refund.run(m.uuid, month()); giveBack(); throw e; }
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

/* ---------- AI providers ---------- */
// The admin keeps an ordered list of models (each on a provider). Every AI call walks it top to bottom and uses the first
// model that is enabled, not cooling down after a rate limit, under its own budget and under the global budget.
// Any failure (rate limit, outage, bad key, unusable reply) falls through to the next model.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_providers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS ai_models (id INTEGER PRIMARY KEY, provider INTEGER NOT NULL, model TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, vision INTEGER NOT NULL DEFAULT 1, price_in REAL NOT NULL DEFAULT 0, price_out REAL NOT NULL DEFAULT 0,
    budget REAL, period TEXT NOT NULL DEFAULT 'month', max_calls INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_error_at INTEGER);
  CREATE TABLE IF NOT EXISTS ai_spend (model INTEGER NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, PRIMARY KEY (model, day));
`);
const AI_KINDS = ['anthropic', 'openai'];
const PERIODS = ['day', 'week', 'month'];
const KNOWN_PRICES = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] }; // USD per 1M tokens, for the seed only
// Providers from the environment. For each one whose key (or URL) is set, a provider is created once, tied to that env var
// (its key is read from the env on every call, never stored). <PREFIX>_MODELS optionally adds models to the end of the chain:
// comma-separated, each "model" or "model@IN/OUT" (USD per 1M tokens). Paid models get AI_MODEL_BUDGET (default $50) per month;
// "@0/0" and local models are free; a model with no known price is added switched off until you set its prices.
// Everything is only ever added: after that, the admin center owns the list.
const ENV_PROVIDERS = [
  // env var, name, kind, base URL (overridable with <PREFIX>_BASE_URL), models prefix
  ['ANTHROPIC_API_KEY', 'Anthropic', 'anthropic', 'https://api.anthropic.com', 'ANTHROPIC'],
  ['OPENAI_API_KEY', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'OPENAI'],
  ['OPENROUTER_API_KEY', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1', 'OPENROUTER'],
  ['GEMINI_API_KEY', 'Google Gemini', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI'],
  ['GROQ_API_KEY', 'Groq', 'openai', 'https://api.groq.com/openai/v1', 'GROQ'],
  ['MISTRAL_API_KEY', 'Mistral', 'openai', 'https://api.mistral.ai/v1', 'MISTRAL'],
  ['OLLAMA_URL', 'Ollama', 'openai', null, 'OLLAMA'], // no key: the URL itself, e.g. http://ollama:11434/v1
];
if (!db.prepare('PRAGMA table_info(ai_providers)').all().some((c) => c.name === 'env')) {
  db.exec('ALTER TABLE ai_providers ADD COLUMN env TEXT');
  // providers created before this existed borrowed the env key by type; tie them to the right variable explicitly
  db.exec("UPDATE ai_providers SET env = 'ANTHROPIC_API_KEY' WHERE kind = 'anthropic' AND api_key = ''");
  db.exec("UPDATE ai_providers SET env = 'OPENAI_API_KEY' WHERE kind = 'openai' AND api_key = '' AND base_url LIKE 'https://api.openai.com%'");
}
const DEFAULT_BUDGET = Number(process.env.AI_MODEL_BUDGET ?? 50);
for (const [env, name, kind, url, prefix] of ENV_PROVIDERS) {
  if (!process.env[env]) continue;
  let prov = db.prepare('SELECT id FROM ai_providers WHERE env = ?').get(env)?.id;
  const firstTime = !prov;
  if (firstTime) prov = Number(db.prepare('INSERT INTO ai_providers (name, kind, base_url, env) VALUES (?, ?, ?, ?)')
    .run(name, kind, (process.env[prefix + '_BASE_URL'] || url || process.env[env]).replace(/\/$/, ''), env).lastInsertRowid);
  const list = process.env[prefix + '_MODELS'] || (firstTime && env === 'ANTHROPIC_API_KEY' ? process.env.CLAUDE_MODEL || 'claude-sonnet-5-5' : '');
  for (const entry of list.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [, model, pin, pout] = /^(.+?)(?:@([\d.]+)\/([\d.]+))?$/.exec(entry);
    if (db.prepare('SELECT 1 FROM ai_models WHERE provider = ? AND model = ?').get(prov, model)) continue;
    const price = pin !== undefined ? [Number(pin), Number(pout)] : env === 'OLLAMA_URL' ? [0, 0] : KNOWN_PRICES[model];
    const pos = (db.prepare('SELECT MAX(position) AS p FROM ai_models').get().p ?? -1) + 1;
    const free = price && !price[0] && !price[1];
    db.prepare('INSERT INTO ai_models (provider, model, position, enabled, price_in, price_out, budget, period) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(prov, model, pos, price ? 1 : 0, price ? price[0] : 0, price ? price[1] : 0, price && !free ? DEFAULT_BUDGET : null, 'month');
    if (!price) console.warn(`AI: ${model} (${name}) was added switched off: set its prices in the admin center, or write it as ${model}@IN/OUT.`);
  }
}
// A total budget from the env applies until the admin sets one: AI_BUDGET=100, AI_BUDGET_PERIOD=day|week|month.
if (process.env.AI_BUDGET && !setting('ai_budget', '')) db.prepare("INSERT INTO settings (key, value) VALUES ('ai_budget', ?)")
  .run(JSON.stringify({ amount: Number(process.env.AI_BUDGET), period: PERIODS.includes(process.env.AI_BUDGET_PERIOD) ? process.env.AI_BUDGET_PERIOD : 'month' }));
// Provider API keys are stored encrypted (AES-256-GCM) with a key derived from SECRET_KEY, which lives only in the server env:
// a copied database or backup doesn't expose them. Without SECRET_KEY the admin center refuses to save keys.
const SECRET = process.env.SECRET_KEY ? crypto.createHash('sha256').update(process.env.SECRET_KEY).digest() : null;
const SEALED = 'enc:v1:';
const seal = (plain) => {
  if (!SECRET) throw fail(400, 'Set SECRET_KEY on the server first: API keys are stored encrypted with it.');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return SEALED + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const unseal = (stored) => { // '' when missing, or when SECRET_KEY is missing or changed
  if (!stored || !stored.startsWith(SEALED) || !SECRET) return '';
  try {
    const b = Buffer.from(stored.slice(SEALED.length), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', SECRET, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return ''; }
};
// Keys saved before encryption existed: encrypt them now (or warn until SECRET_KEY is set).
for (const r of db.prepare("SELECT id, api_key FROM ai_providers WHERE api_key != '' AND api_key NOT LIKE 'enc:v1:%'").all()) {
  if (SECRET) db.prepare('UPDATE ai_providers SET api_key = ? WHERE id = ?').run(seal(r.api_key), r.id);
  else console.warn(`AI provider ${r.id} has an unencrypted API key: set SECRET_KEY and restart to encrypt it.`);
}
// A saved key wins; otherwise only the env var this provider is tied to (never another provider's key). Ollama-style env URLs have no key.
const keyOf = (p) => (p.api_key && !p.api_key.startsWith(SEALED) ? p.api_key : unseal(p.api_key)) || (p.env && p.env.endsWith('_API_KEY') ? process.env[p.env] : '') || '';
const keyLabel = (p) => { // what the admin center shows instead of the key
  if (!p.api_key) return p.env ? (process.env[p.env] ? `from ${p.env}` : `${p.env} is not set`) : '';
  const k = keyOf({ ...p, env: null });
  return k ? '••••' + k.slice(-4) : 'saved key unreadable (SECRET_KEY changed?): enter it again';
};
const periodStart = (period) => {
  const d = new Date(); if (period === 'month') d.setUTCDate(1);
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
  return d.toISOString().slice(0, 10);
};
const aiQ = {
  chain: db.prepare('SELECT m.*, p.name AS provider_name, p.kind, p.base_url, p.api_key, p.env FROM ai_models m JOIN ai_providers p ON p.id = m.provider ORDER BY m.position, m.id'),
  spent: db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(calls), 0) AS calls FROM ai_spend WHERE model = ? AND day >= ?'),
  spentAll: db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM ai_spend WHERE day >= ?'),
  record: db.prepare(`INSERT INTO ai_spend (model, day, calls, tokens_in, tokens_out, cost) VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(model, day) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, cost = cost + excluded.cost`),
  error: db.prepare('UPDATE ai_models SET last_error = ?, last_error_at = unixepoch(), cooldown_until = MAX(cooldown_until, ?) WHERE id = ?'),
  ok: db.prepare('UPDATE ai_models SET last_error = NULL, cooldown_until = 0 WHERE id = ?'),
};
const globalBudget = () => JSON.parse(setting('ai_budget', '{"amount":null,"period":"month"}'));
const isFree = (m) => !m.price_in && !m.price_out;
// Why a model can't take a call right now ('' = it can).
function blocked(m, needsVision) {
  if (!m.enabled) return 'disabled';
  if (needsVision && !m.vision) return 'no image input';
  if (m.cooldown_until > Date.now() / 1000) return 'cooling down after an error';
  if (m.env && !process.env[m.env] && !m.api_key) return `${m.env} is not set`;
  if (m.kind === 'anthropic' && !keyOf(m)) return 'no API key';
  const s = aiQ.spent.get(m.id, periodStart(m.period));
  if (m.budget != null && !isFree(m) && s.cost >= m.budget) return `budget reached for this ${m.period}`;
  if (m.max_calls != null && s.calls >= m.max_calls) return `call limit reached for this ${m.period}`;
  const g = globalBudget();
  if (g.amount != null && !isFree(m) && aiQ.spentAll.get(periodStart(g.period)).cost >= g.amount) return `global budget reached for this ${g.period}`;
  return '';
}
// Adapters take Anthropic-shaped content (string, or [{type:'image'}, {type:'text'}]) and return { text, tin, tout, problem }.
// problem: the reply was billed but can't be used (cut off, refused); it falls through to the next model without a cooldown.
const ADAPTERS = {
  async anthropic(m, content, system, maxTokens) {
    const r = await fetch(`${m.base_url.replace(/\/$/, '')}/v1/messages`, { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', 'x-api-key': keyOf(m), 'anthropic-version': '2023-06-01' },
      // Current Claude models always think, and thinking counts toward max_tokens: leave plenty of room (it's a ceiling, not a cost).
      body: JSON.stringify({ model: m.model, max_tokens: Math.max(maxTokens, 16000), system, messages: [{ role: 'user', content }] }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d?.error?.message || `HTTP ${r.status}`), { status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 });
    const problem = d.stop_reason === 'refusal' ? 'The model declined this request.' : d.stop_reason === 'max_tokens' ? 'Reply cut off (max_tokens reached).' : '';
    return { text: (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), tin: d.usage?.input_tokens || 0, tout: d.usage?.output_tokens || 0, problem };
  },
  // OpenAI, OpenRouter, Google Gemini (OpenAI endpoint), Groq, Mistral, Ollama, LM Studio…: base URL ends in /v1 (or equivalent).
  async openai(m, content, system, maxTokens) {
    const parts = typeof content === 'string' ? content : content.map((c) => (c.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } } : { type: 'text', text: c.text }));
    const key = keyOf(m);
    const r = await fetch(`${m.base_url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model: m.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: parts }] }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d?.error?.message || `HTTP ${r.status}`), { status: r.status, retryAfter: Number(r.headers.get('retry-after')) || 0 });
    const problem = d.choices?.[0]?.finish_reason === 'length' ? 'Reply cut off (token limit reached).' : '';
    return { text: d.choices?.[0]?.message?.content || '', tin: d.usage?.prompt_tokens || 0, tout: d.usage?.completion_tokens || 0, problem };
  },
};
// One model, one attempt: records spend on success, the error (and a cooldown on rate limits/outages) on failure.
async function tryModel(m, content, system, maxTokens, parse) {
  let text, problem;
  try {
    const r = await ADAPTERS[m.kind](m, content, system, maxTokens); text = r.text; problem = r.problem;
    aiQ.record.run(m.id, today(), r.tin, r.tout, (r.tin * m.price_in + r.tout * m.price_out) / 1e6); // ponytail: spend is checked before the call, so one call can overshoot a budget
  } catch (e) { // the provider failed: rate limits and outages bench the model for a while
    const cool = e.status === 429 ? e.retryAfter || 60 : e.status >= 500 || e.name === 'TimeoutError' || !e.status ? 30 : 0;
    aiQ.error.run(String(e.message).slice(0, 300), cool ? Math.floor(Date.now() / 1000) + cool : 0, m.id);
    throw e;
  }
  try { if (problem) throw new Error(problem); const out = parse(text); aiQ.ok.run(m.id); return out; }
  catch (e) { aiQ.error.run('Unusable reply: ' + String(e.message).slice(0, 280), 0, m.id); throw e; } // no cooldown: the next request may parse fine
}
const aiOn = () => aiQ.chain.all().some((m) => !blocked(m, false));
async function callAI(content, system, maxTokens = 3000, parse = (t) => t) {
  const needsVision = Array.isArray(content) && content.some((c) => c.type === 'image');
  const tried = [];
  for (const m of aiQ.chain.all()) {
    const why = blocked(m, needsVision);
    if (why) { tried.push(`${m.model}: ${why}`); continue; }
    try { return await tryModel(m, content, system, maxTokens, parse); }
    catch (e) { tried.push(`${m.model}: ${e.message}`); }
  }
  if (tried.length) console.warn('AI: no model could answer |', tried.join(' | '));
  throw fail(503, tried.length ? 'The AI is busy right now, try again in a few minutes.' : 'AI is off: add a provider and a model in the admin center.');
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
      return send(res, 200, { month: mo, limits: LIMITS, featureLimits: FEATURE_LIMITS, members: q.admin.all(mo).map((r) => ({ ...r, usage: { [mo]: r.used } })) });
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
    /* AI providers & models: the fallback chain, budgets and spend */
    if (p === '/api/admin/ai' && req.method === 'GET') {
      const g = globalBudget();
      return send(res, 200, {
        kinds: AI_KINDS, periods: PERIODS,
        budget: { ...g, spent: aiQ.spentAll.get(periodStart(g.period)).cost, since: periodStart(g.period) },
        secret: Boolean(SECRET),
        providers: db.prepare('SELECT * FROM ai_providers ORDER BY id').all().map(({ api_key, ...x }) => ({ ...x, key: keyLabel({ ...x, api_key }) })),
        models: aiQ.chain.all().map((row) => {
          const { api_key, base_url, env, ...m } = row, s = aiQ.spent.get(m.id, periodStart(m.period)); // never send keys to the browser
          return { ...m, spent: s.cost, calls: s.calls, since: periodStart(m.period), free: isFree(m), blocked: blocked(row, false) };
        }),
      });
    }
    if (p === '/api/admin/ai/budget' && req.method === 'PUT') {
      const b = await readBody(req, 4096);
      if (!PERIODS.includes(b.period)) throw fail(400, 'Period is day, week or month.');
      const amount = b.amount === '' || b.amount == null ? null : Math.max(0, Number(b.amount));
      if (amount !== null && !Number.isFinite(amount)) throw fail(400, 'The budget must be a number.');
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('ai_budget', JSON.stringify({ amount, period: b.period }));
      return send(res, 200, { ok: true });
    }
    const prov = /^\/api\/admin\/ai\/providers(?:\/(\d+))?$/.exec(p);
    if (prov && (req.method === 'POST' || req.method === 'PUT')) {
      const b = await readBody(req, 8192);
      if (!AI_KINDS.includes(b.kind)) throw fail(400, 'Unknown provider type.');
      const u = new URL(String(b.base_url || '')); if (!/^https?:$/.test(u.protocol)) throw fail(400, 'The base URL must be http(s).');
      const name = String(b.name || '').trim().slice(0, 60) || u.hostname;
      if (req.method === 'POST') return send(res, 200, { id: Number(db.prepare('INSERT INTO ai_providers (name, kind, base_url, api_key) VALUES (?, ?, ?, ?)').run(name, b.kind, u.href.replace(/\/$/, ''), b.api_key ? seal(String(b.api_key).trim()) : '').lastInsertRowid) });
      db.prepare('UPDATE ai_providers SET name = ?, kind = ?, base_url = ? WHERE id = ?').run(name, b.kind, u.href.replace(/\/$/, ''), prov[1]);
      if (b.api_key) db.prepare('UPDATE ai_providers SET api_key = ? WHERE id = ?').run(seal(String(b.api_key).trim()), prov[1]); // empty = keep the current key
      return send(res, 200, { ok: true });
    }
    if (prov && prov[1] && req.method === 'DELETE') {
      db.prepare('DELETE FROM ai_spend WHERE model IN (SELECT id FROM ai_models WHERE provider = ?)').run(prov[1]);
      db.prepare('DELETE FROM ai_models WHERE provider = ?').run(prov[1]); db.prepare('DELETE FROM ai_providers WHERE id = ?').run(prov[1]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/ai/order' && req.method === 'PUT') {
      const b = await readBody(req, 16384);
      if (!Array.isArray(b.ids)) throw fail(400, 'Send { ids: [...] } top to bottom.');
      const set = db.prepare('UPDATE ai_models SET position = ? WHERE id = ?'); b.ids.forEach((id, i) => set.run(i, Number(id)));
      return send(res, 200, { ok: true });
    }
    const mod = /^\/api\/admin\/ai\/models(?:\/(\d+))?(\/test)?$/.exec(p);
    if (mod && mod[2] && req.method === 'POST') {
      const m = aiQ.chain.all().find((x) => x.id === Number(mod[1])); if (!m) throw fail(404, 'No such model.');
      const t0 = Date.now();
      try { const text = await tryModel(m, 'Reply with the single word OK.', 'You are a health check.', 50, (x) => x); return send(res, 200, { ok: true, ms: Date.now() - t0, reply: String(text).slice(0, 80) }); }
      catch (e) { return send(res, 200, { ok: false, ms: Date.now() - t0, error: e.message }); }
    }
    if (mod && (req.method === 'POST' || req.method === 'PUT')) {
      const b = await readBody(req, 8192);
      const num = (v, min = 0) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : (() => { throw fail(400, 'Prices, budgets and limits must be numbers.'); })());
      if (!PERIODS.includes(b.period)) throw fail(400, 'Period is day, week or month.');
      const model = String(b.model || '').trim().slice(0, 120); if (!model) throw fail(400, 'Name the model, e.g. claude-sonnet-5-5.');
      const v = [model, b.enabled ? 1 : 0, b.vision ? 1 : 0, num(b.price_in) || 0, num(b.price_out) || 0, num(b.budget), b.period, num(b.max_calls) === null ? null : Math.floor(num(b.max_calls))];
      if (req.method === 'POST') {
        if (!db.prepare('SELECT 1 FROM ai_providers WHERE id = ?').get(Number(b.provider))) throw fail(400, 'Pick a provider.');
        const pos = (db.prepare('SELECT MAX(position) AS p FROM ai_models').get().p ?? -1) + 1;
        return send(res, 200, { id: Number(db.prepare('INSERT INTO ai_models (model, enabled, vision, price_in, price_out, budget, period, max_calls, provider, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...v, Number(b.provider), pos).lastInsertRowid) });
      }
      db.prepare('UPDATE ai_models SET model = ?, enabled = ?, vision = ?, price_in = ?, price_out = ?, budget = ?, period = ?, max_calls = ?, cooldown_until = 0 WHERE id = ?').run(...v, mod[1]);
      return send(res, 200, { ok: true });
    }
    if (mod && mod[1] && req.method === 'DELETE') { db.prepare('DELETE FROM ai_models WHERE id = ?').run(mod[1]); db.prepare('DELETE FROM ai_spend WHERE model = ?').run(mod[1]); return send(res, 200, { ok: true }); }
    const reset = /^\/api\/admin\/members\/([a-f0-9-]+)\/reset$/i.exec(p);
    if (reset && req.method === 'POST') { q.reset.run(reset[1], month()); return send(res, 200, { ok: true }); }
    throw fail(404, 'Not found');
  }

  const m = await currentMember(req);
  if (!m) throw fail(401, 'Sign in first.');
  const row = q.get.get(m.uuid);
  const stock = JSON.parse(row.stock), recipes = JSON.parse(row.recipes);

  if (p === '/api/me') {
    return send(res, 200, { member: { email: m.email, name: m.name, status: m.status }, usage: usageOf(m), ai: aiOn(),
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
    // Anything that disappeared (e.g. counted down to zero) goes to the trash, restorable.
    const ids = new Set(next.map((x) => x && x.id));
    const trashed = stock.filter((x) => x && x.id && !ids.has(x.id)).map((x) => ({ item: x.id, trash: toTrash(m.uuid, { type: 'stock', item: x }) }));
    q.setStock.run(JSON.stringify(next.slice(0, 500)), m.uuid);
    const seen = new Set(JSON.parse(q.getSeen.get(m.uuid)?.seen || '[]'));
    for (const x of next) if (x && x.name) seen.add(String(x.name).toLowerCase().slice(0, 60));
    q.setSeen.run(JSON.stringify([...seen].slice(-1000)), m.uuid);
    return send(res, 200, { ok: true, trashed });
  }

  if (p === '/api/ingredients/history' && req.method === 'GET') {
    const count = new Map();
    const add = (n, w) => { const k = String(n || '').toLowerCase().trim(); if (k) count.set(k, (count.get(k) || 0) + w); };
    JSON.parse(q.getSeen.get(m.uuid)?.seen || '[]').forEach((n) => add(n, 2));
    recipes.forEach((r) => (r.steps || []).forEach((st) => (st.uses || []).forEach((u) => add(u.name, 1))));
    return send(res, 200, [...count].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([name, n]) => ({ name, n })));
  }

  // Today's pick: one recipe a day from the member's stock. Free (the site's gift), cached per day, claimable.
  if (p === '/api/daily' && req.method === 'GET') {
    const d = JSON.parse(q.getDaily.get(m.uuid)?.daily || 'null');
    if (d && d.date === today()) return send(res, 200, d);
    if (!stock.length || !aiOn()) return send(res, 200, null);
    const lang = langOf(new URL(req.url, 'http://x').searchParams.get('lang'));
    if (!dailyJobs.has(m.uuid)) {
      const prompt = `Create one inviting everyday recipe, today's pick, using mainly these ingredients: ${stock.map((x) => x.name).slice(0, 60).join(', ')}.\n` +
        'Assume salt, pepper, oil and water are available; anything else not listed is optional or minimal.\n' + RECIPE_SHAPE + writeIn(lang);
      dailyJobs.set(m.uuid, callAI(prompt, RECIPE_SYSTEM, 3000, (text) => asRecipe(text, { id: 'daily-' + today(), lang: lang || undefined, daily: true })).then((recipe) => {
        const daily = { date: today(), recipe, claimed: false };
        q.setDaily.run(JSON.stringify(daily), m.uuid); track('daily');
        return daily;
      }).finally(() => dailyJobs.delete(m.uuid)));
    }
    return send(res, 200, await dailyJobs.get(m.uuid));
  }
  if (p === '/api/daily/claim' && req.method === 'POST') {
    const d = JSON.parse(q.getDaily.get(m.uuid)?.daily || 'null');
    if (!d || d.date !== today()) throw fail(404, 'Today\'s pick is not ready yet.');
    const copy = { ...d.recipe, id: 'r' + Date.now().toString(36), daily: undefined, collections: [] };
    if (!d.claimed) { q.setRecipes.run(JSON.stringify([...recipes, copy]), m.uuid); d.claimed = copy.id; q.setDaily.run(JSON.stringify(d), m.uuid); }
    return send(res, 200, d);
  }

  if (p === '/api/tags' && req.method === 'GET') return send(res, 200, { mode: aiTagMode(), tags: tagList() });

  // Collections: [{ id, name }]. A recipe lists the collections it's in as recipe.collections = [ids].
  let cols = JSON.parse(q.getCols.get(m.uuid)?.collections || 'null');
  if (!cols) { cols = (STARTER[langOf(new URL(req.url, 'http://x').searchParams.get('lang'))] || STARTER.en).map((name) => ({ id: newId('c'), name, layout: 'stack', starter: true })); q.setCols.run(JSON.stringify(cols), m.uuid); }
  if (!cols.some((c) => c.special)) { cols.unshift({ id: 'all', special: true, layout: 'stack' }); q.setCols.run(JSON.stringify(cols), m.uuid); }
  if (cols.filter((c) => !c.special).slice(0, 3).some((c) => !c.seeded)) {
    // Fill each starter collection with default recipes once (also for accounts created before this existed).
    const have = new Set(recipes.map((r) => r.id)), seed = JSON.parse(SEED);
    const starters = cols.filter((c) => !c.special).slice(0, 3);
    cols = cols.map((c) => {
      const k = starters.indexOf(c);
      if (k < 0 || c.seeded) return c;
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
  const colM = /^\/api\/collections\/(c[a-z0-9]+|all)$/.exec(p);
  if (colM && req.method === 'PATCH') {
    // Collection settings: name, layout (stack | grid | list), hidden, cover recipe, move (-1 / 1 to reorder).
    const b = await readBody(req, 4096), i = cols.findIndex((c) => c.id === colM[1]);
    if (i < 0) throw fail(404, 'Not found');
    const c = { ...cols[i] };
    if (b.name !== undefined && !c.special) { c.name = String(b.name).trim().slice(0, 60); if (!c.name) throw fail(400, 'Give the collection a name.'); }
    if (b.layout !== undefined) { if (!LAYOUTS.includes(b.layout)) throw fail(400, 'Unknown layout.'); c.layout = b.layout; }
    if (b.hidden !== undefined) c.hidden = Boolean(b.hidden);
    if (b.cover !== undefined) c.cover = recipes.some((r) => r.id === b.cover) ? b.cover : '';
    cols[i] = c;
    const j = i + (b.move === -1 ? -1 : b.move === 1 ? 1 : 0);
    if (j !== i && j >= 0 && j < cols.length) [cols[i], cols[j]] = [cols[j], cols[i]];
    q.setCols.run(JSON.stringify(cols), m.uuid);
    return send(res, 200, cols);
  }
  if (colM && req.method === 'DELETE' && colM[1] === 'all') throw fail(400, '"All" is built in and can\'t be deleted, but you can hide it.');
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
    if (entry.type === 'stock') {
      const it = { ...entry.item, qty: Math.max(1, Number(entry.item.qty) || 1) };
      if (stock.some((x) => x.id === it.id)) it.id = newId('s');
      q.setStock.run(JSON.stringify([...stock, it]), m.uuid);
    } else if (entry.type === 'recipe') {
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
    r.collections = [...new Set((Array.isArray(r.collections) ? r.collections : []).filter((id) => cols.some((c) => c.id === id && !c.special)))];
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
    const items = await withQuota(m, 'recognize', async () => (await callAI([img, { type: 'text', text: prompt }], 'You identify food in photos for a kitchen stock tracker. Reply with JSON only.', 1200, extractJson)).items);
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
    const out = await withQuota(m, 'sort', async () => await callAI(prompt, 'You organise a kitchen stock into categories. Reply with JSON only.', 4000, extractJson));
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
    return send(res, 200, await withQuota(m, 'generate', async () => await callAI(prompt, RECIPE_SYSTEM, 3000, (t) => asRecipe(t, { generated: true, lang: langOf(body.lang) || undefined }))));
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
      const r = await callAI(content, RECIPE_SYSTEM, 4000, (t) => asRecipe(t, { lang: langOf(body.lang) || undefined }));
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
    return send(res, 200, await withQuota(m, 'translate', async () => ({ ...await callAI(prompt, RECIPE_SYSTEM, 4000, asRecipe), id: `${id || 'r'}-${l}`, source, lang: l })));
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
  console.log(`Recepees gateway on :${PORT} -> Ghost ${GHOST}, OCR ${OCR} | AI models ${aiQ.chain.all().filter((m) => m.enabled).map((m) => m.model).join(' → ') || 'none'} | admin ${ADMIN_TOKEN ? 'on' : 'off (set ADMIN_TOKEN)'} | stored API keys ${SECRET ? 'encrypted' : 'off (set SECRET_KEY)'}`);
});
const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
