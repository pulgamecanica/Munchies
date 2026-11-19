#!/usr/bin/env node
// Recepees gateway: the only public port.
//   /api/*  -> our API (recipe box, stock, AI, usage, admin center)
//   else    -> proxied to Ghost (theme, members, Portal, Stripe, /ghost admin)
// Same origin = the Ghost member cookie reaches us, so we ask Ghost who's logged in.
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const PORT = Number(process.env.PORT) || 3000;
const GHOST = process.env.GHOST_URL || 'http://ghost:2368';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data', 'members');
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LIMITS = { free: Number(process.env.FREE_AI_PER_MONTH ?? 5), paid: Number(process.env.PAID_AI_PER_MONTH ?? 200) };
fs.mkdirSync(DATA, { recursive: true });

let SEED = [];
try { SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-recipes.json'), 'utf8')); } catch {}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

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

/* ---------- members ---------- */
// ponytail: one Ghost round-trip per API call; cache by cookie if it ever shows up in latency.
async function currentMember(req) {
  if (!req.headers.cookie) return null;
  const r = await fetch(GHOST + '/members/api/member/', {
    headers: { cookie: req.headers.cookie, host: req.headers.host || 'localhost', 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' },
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const m = await r.json().catch(() => null);
  return m && m.uuid ? m : null;
}
const tierOf = (m) => (m.status === 'free' ? 'free' : 'paid'); // paid + comped
const month = () => new Date().toISOString().slice(0, 7);

// ponytail: one JSON file per member, fine for thousands; move to SQLite when admin listing gets slow.
const fileOf = (uuid) => path.join(DATA, uuid.replace(/[^a-f0-9-]/gi, '') + '.json');
function load(m) {
  try { return JSON.parse(fs.readFileSync(fileOf(m.uuid), 'utf8')); }
  catch { return { email: m.email, stock: [], recipes: SEED.map((r) => ({ ...r })), usage: {} }; }
}
function save(uuid, box) {
  const f = fileOf(uuid);
  fs.writeFileSync(f + '.tmp', JSON.stringify(box, null, 2));
  fs.renameSync(f + '.tmp', f);
}
const usageOf = (m, box) => ({ month: month(), used: box.usage[month()] || 0, limit: LIMITS[tierOf(m)], tier: tierOf(m) });

// Reserve one AI call before the (slow) request, refund if it fails. Sync = no race in one process.
async function withQuota(m, fn) {
  let box = load(m);
  const u = usageOf(m, box);
  if (u.used >= u.limit) throw fail(402, `You've used all ${u.limit} AI tables this month. Upgrade for more.`);
  box.usage[u.month] = u.used + 1; box.email = m.email; save(m.uuid, box);
  try { return await fn(); }
  catch (e) { box = load(m); box.usage[u.month] = Math.max(0, (box.usage[u.month] || 1) - 1); save(m.uuid, box); throw e; }
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

/* ---------- admin center ---------- */
function adminList() {
  return fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => {
    const b = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
    return { uuid: f.slice(0, -5), email: b.email, recipes: b.recipes.length, stock: b.stock.length, usage: b.usage };
  });
}

/* ---------- routes ---------- */
async function api(req, res, p) {
  if (p === '/api/health') return send(res, 200, { ok: true });

  if (p === '/api/admin' || p === '/api/admin/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'admin.html')), 'text/html; charset=utf-8');
  if (p.startsWith('/api/admin/')) {
    if (!ADMIN_TOKEN || req.headers.authorization !== 'Bearer ' + ADMIN_TOKEN) throw fail(401, 'Bad admin token.');
    if (p === '/api/admin/members' && req.method === 'GET') return send(res, 200, { month: month(), limits: LIMITS, members: adminList() });
    const reset = /^\/api\/admin\/members\/([a-f0-9-]+)\/reset$/i.exec(p);
    if (reset && req.method === 'POST') {
      const box = JSON.parse(fs.readFileSync(fileOf(reset[1]), 'utf8'));
      box.usage[month()] = 0; save(reset[1], box);
      return send(res, 200, { ok: true });
    }
    throw fail(404, 'Not found');
  }

  const m = await currentMember(req);
  if (!m) throw fail(401, 'Sign in first.');
  const box = load(m);

  if (p === '/api/me') return send(res, 200, { member: { email: m.email, name: m.name, status: m.status }, usage: usageOf(m, box), ai: Boolean(process.env.ANTHROPIC_API_KEY) });

  if (p === '/api/stock' && req.method === 'GET') return send(res, 200, box.stock);
  if (p === '/api/stock' && req.method === 'PUT') {
    const stock = await readBody(req);
    if (!Array.isArray(stock)) throw fail(400, 'Stock must be an array');
    box.stock = stock.slice(0, 500); box.email = m.email; save(m.uuid, box);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, box.recipes);
  if (p === '/api/recipes' && req.method === 'POST') {
    const r = await readBody(req);
    if (!r.title || !Array.isArray(r.steps)) throw fail(400, 'Invalid recipe');
    r.id = r.id || 'r' + Date.now().toString(36);
    box.recipes = [...box.recipes.filter((x) => x.id !== r.id), r].slice(-1000); save(m.uuid, box);
    return send(res, 200, r);
  }
  if (p.startsWith('/api/recipes/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.split('/').pop());
    box.recipes = box.recipes.filter((r) => r.id !== id); save(m.uuid, box);
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'POST') throw fail(404, 'Not found');
  const body = await readBody(req);

  if (p === '/api/recognize') {
    const img = imagePart(body.image);
    const items = await withQuota(m, async () => extractJson(await callClaude([img, { type: 'text', text: RECOGNIZE_PROMPT }], 'You identify food in photos for a kitchen stock tracker. Reply with JSON only.', 1200)).items);
    return send(res, 200, { items: Array.isArray(items) ? items : [] });
  }
  if (p === '/api/generate') {
    const ing = (body.ingredients || []).map(String).slice(0, 80);
    if (!ing.length) throw fail(400, 'Pick at least one ingredient.');
    const prompt = `Create one recipe using mainly these ingredients: ${ing.join(', ')}.\n` +
      (body.notes ? `Preferences: ${String(body.notes).slice(0, 500)}\n` : '') +
      'Assume salt, pepper, oil and water are available; anything else not listed is optional or minimal.\n' + RECIPE_SHAPE;
    return send(res, 200, await withQuota(m, async () => asRecipe(await callClaude(prompt, RECIPE_SYSTEM), { generated: true })));
  }
  if (p === '/api/convert') {
    // "Make a table": from a link, pasted text, or a photo of a cookbook page.
    let content, source = {};
    if (body.image) content = [imagePart(body.image), { type: 'text', text: 'Convert the recipe in this photo.\n' + RECIPE_SHAPE }];
    else if (body.url) {
      const page = await fetchPage(String(body.url));
      source = { url: page.url };
      content = `Convert the recipe on this page (source ${page.url}).\n${RECIPE_SHAPE}\n\n${page.text.slice(0, 60000)}`;
    } else if (body.text) content = `Convert this recipe.\n${RECIPE_SHAPE}\n\n${String(body.text).slice(0, 30000)}`;
    else throw fail(400, 'Send a url, text or image.');
    return send(res, 200, await withQuota(m, async () => {
      const r = asRecipe(await callClaude(content, RECIPE_SYSTEM, 4000));
      return { ...r, source: { ...(r.source || {}), ...source } };
    }));
  }
  throw fail(404, 'Not found');
}

function proxy(req, res) {
  const headers = { ...req.headers, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' };
  headers['x-forwarded-for'] = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ');
  const up = http.request(GHOST + req.url, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) send(res, 502, 'Ghost is starting up, refresh in a few seconds.', 'text/plain'); else res.destroy(); });
  req.pipe(up);
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (!p.startsWith('/api/')) return proxy(req, res);
  try { await api(req, res, p); }
  catch (e) { send(res, e.status || 500, { error: e.message || 'Server error' }); }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Recepees gateway on :${PORT} -> Ghost ${GHOST} | AI ${process.env.ANTHROPIC_API_KEY ? 'on (' + MODEL + ')' : 'off'} | admin ${ADMIN_TOKEN ? 'on' : 'off (set ADMIN_TOKEN)'}`);
});
