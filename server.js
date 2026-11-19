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
`);
let SEED = '[]';
try { SEED = JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-recipes.json'), 'utf8'))); } catch {}

const q = {
  upsert: db.prepare('INSERT INTO members (uuid, email, recipes) VALUES (?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET email = excluded.email'),
  get: db.prepare('SELECT stock, recipes FROM members WHERE uuid = ?'),
  setStock: db.prepare('UPDATE members SET stock = ? WHERE uuid = ?'),
  setRecipes: db.prepare('UPDATE members SET recipes = ? WHERE uuid = ?'),
  used: db.prepare('SELECT used FROM usage WHERE uuid = ? AND month = ?'),
  // Atomic: only counts when under the limit, so parallel requests can't overshoot.
  take: db.prepare('INSERT INTO usage (uuid, month, used) VALUES (?, ?, 1) ON CONFLICT(uuid, month) DO UPDATE SET used = used + 1 WHERE used < ?'),
  refund: db.prepare('UPDATE usage SET used = MAX(0, used - 1) WHERE uuid = ? AND month = ?'),
  reset: db.prepare('UPDATE usage SET used = 0 WHERE uuid = ? AND month = ?'),
  admin: db.prepare(`SELECT m.uuid, m.email, json_array_length(m.recipes) AS recipes, json_array_length(m.stock) AS stock, COALESCE(u.used, 0) AS used
                     FROM members m LEFT JOIN usage u ON u.uuid = m.uuid AND u.month = ? ORDER BY used DESC, m.email`),
};
const month = () => new Date().toISOString().slice(0, 7);
const tierOf = (m) => (m.status === 'free' ? 'free' : 'paid'); // paid + comped
const usageOf = (m) => ({ month: month(), used: q.used.get(m.uuid, month())?.used || 0, limit: LIMITS[tierOf(m)], tier: tierOf(m) });

async function withQuota(m, fn) {
  const limit = LIMITS[tierOf(m)];
  if (limit <= 0 || q.take.run(m.uuid, month(), limit).changes === 0) throw fail(402, "You've used all your AI uses this month. Upgrade for more.");
  try { return await fn(); } catch (e) { q.refund.run(m.uuid, month()); throw e; }
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

/* ---------- members ---------- */
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
  const data = r && r.ok ? await r.json().catch(() => null) : null;
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
      { 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  }
  if (p.startsWith('/api/admin/')) {
    if (!ADMIN_TOKEN || req.headers.authorization !== 'Bearer ' + ADMIN_TOKEN) throw fail(401, 'Bad admin token.');
    if (p === '/api/admin/members' && req.method === 'GET') {
      const mo = month();
      return send(res, 200, { month: mo, limits: LIMITS, members: q.admin.all(mo).map((r) => ({ ...r, usage: { [mo]: r.used } })) });
    }
    const reset = /^\/api\/admin\/members\/([a-f0-9-]+)\/reset$/i.exec(p);
    if (reset && req.method === 'POST') { q.reset.run(reset[1], month()); return send(res, 200, { ok: true }); }
    throw fail(404, 'Not found');
  }

  const m = await currentMember(req);
  if (!m) throw fail(401, 'Sign in first.');
  const row = q.get.get(m.uuid);
  const stock = JSON.parse(row.stock), recipes = JSON.parse(row.recipes);

  if (p === '/api/me') return send(res, 200, { member: { email: m.email, name: m.name, status: m.status }, usage: usageOf(m), ai: Boolean(process.env.ANTHROPIC_API_KEY) });

  if (p === '/api/stock' && req.method === 'GET') return send(res, 200, stock);
  if (p === '/api/stock' && req.method === 'PUT') {
    const next = await readBody(req, 512 * 1024);
    if (!Array.isArray(next)) throw fail(400, 'Stock must be an array');
    q.setStock.run(JSON.stringify(next.slice(0, 500)), m.uuid);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, recipes);
  if (p === '/api/recipes' && req.method === 'POST') {
    const r = await readBody(req, 512 * 1024);
    if (!r.title || !Array.isArray(r.steps)) throw fail(400, 'Invalid recipe');
    r.id = String(r.id || 'r' + Date.now().toString(36)).slice(0, 80);
    q.setRecipes.run(JSON.stringify([...recipes.filter((x) => x.id !== r.id), r].slice(-1000)), m.uuid);
    return send(res, 200, r);
  }
  if (p.startsWith('/api/recipes/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.split('/').pop());
    q.setRecipes.run(JSON.stringify(recipes.filter((r) => r.id !== id)), m.uuid);
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'POST') throw fail(404, 'Not found');
  const body = await readBody(req);

  if (p === '/api/ocr') {
    // Free (not metered): plain text from a photo, so anyone can edit it before making a table.
    const text = await ocr(body.image);
    if (!text) throw fail(422, 'Could not read any text in that photo.');
    return send(res, 200, { text });
  }
  if (p === '/api/recognize') {
    const img = imagePart(body.image);
    const prompt = RECOGNIZE_PROMPT + (langOf(body.lang) ? ` Write names and notes in ${LANG_NAMES[body.lang]} instead of English.` : '');
    const items = await withQuota(m, async () => extractJson(await callClaude([img, { type: 'text', text: prompt }], 'You identify food in photos for a kitchen stock tracker. Reply with JSON only.', 1200)).items);
    return send(res, 200, { items: Array.isArray(items) ? items : [] });
  }
  if (p === '/api/generate') {
    const ing = (body.ingredients || []).map(String).slice(0, 80);
    if (!ing.length) throw fail(400, 'Pick at least one ingredient.');
    const prompt = `Create one recipe using mainly these ingredients: ${ing.join(', ')}.\n` +
      (body.notes ? `Preferences: ${String(body.notes).slice(0, 500)}\n` : '') +
      'Assume salt, pepper, oil and water are available; anything else not listed is optional or minimal.\n' + RECIPE_SHAPE + writeIn(body.lang);
    return send(res, 200, await withQuota(m, async () => asRecipe(await callClaude(prompt, RECIPE_SYSTEM), { generated: true, lang: langOf(body.lang) || undefined })));
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
    return send(res, 200, await withQuota(m, async () => {
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
    return send(res, 200, await withQuota(m, async () => ({ ...asRecipe(await callClaude(prompt, RECIPE_SYSTEM, 4000)), id: `${id || 'r'}-${l}`, source, lang: l })));
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
