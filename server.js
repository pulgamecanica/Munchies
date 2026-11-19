#!/usr/bin/env node
// Recepees — tiny zero-dependency local server.
// Serves the React app, shows your LAN address, stores stock/recipes as JSON,
// and calls the Claude API for photo recognition and recipe generation.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// Optional .env file (ANTHROPIC_API_KEY=...)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
};
const writeJson = (name, value) => {
  const file = path.join(DATA, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
};

const lanAddresses = () => {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  const priv = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return out.sort((a, b) => Number(priv(b)) - Number(priv(a)));
};

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req, limit = 15 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });

async function callClaude(content, system, maxTokens = 2000) {
  if (!hasKey()) {
    const e = new Error('No ANTHROPIC_API_KEY set on the server. Add it to .env and restart.');
    e.status = 503; throw e;
  }
  const r = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `Claude API error (${r.status})`);
    e.status = 502; throw e;
  }
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI reply had no JSON in it.');
  return JSON.parse(text.slice(start, end + 1));
}

const RECOGNIZE_SYSTEM =
  'You identify food items in photos for a kitchen stock tracker. Reply with JSON only, no prose.';
const RECOGNIZE_PROMPT =
  'List every distinct food or cooking ingredient visible (read packaging labels, which may be in French). ' +
  'Ignore non-food objects, bottles of alcohol are fine to include as "drink". ' +
  'Reply exactly as: {"items":[{"name":"lowercase English name","quantity":number,"unit":"pcs|g|ml|pack|bag|tub|bottle|",' +
  '"note":"short detail such as use-by date, or empty"}]}. Count visible units for quantity; use 1 if unsure.';

const GENERATE_SYSTEM =
  'You are a practical home cook. Create one recipe using mainly the ingredients provided. ' +
  'Reply with JSON only, no prose and no markdown fences.';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/info' && req.method === 'GET') {
      return send(res, 200, { port: PORT, ips: lanAddresses(), hasKey: hasKey(), model: MODEL });
    }
    if (p === '/api/recipes' && req.method === 'GET') return send(res, 200, readJson('recipes.json', []));
    if (p === '/api/recipes' && req.method === 'POST') {
      const recipe = await readBody(req);
      if (!recipe.title || !Array.isArray(recipe.steps)) return send(res, 400, { error: 'Invalid recipe' });
      const all = readJson('recipes.json', []);
      recipe.id = recipe.id || 'r' + Date.now().toString(36);
      all.push(recipe); writeJson('recipes.json', all);
      return send(res, 200, recipe);
    }
    if (p.startsWith('/api/recipes/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.split('/').pop());
      writeJson('recipes.json', readJson('recipes.json', []).filter((r) => r.id !== id));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stock' && req.method === 'GET') return send(res, 200, readJson('stock.json', []));
    if (p === '/api/stock' && req.method === 'PUT') {
      const stock = await readBody(req);
      if (!Array.isArray(stock)) return send(res, 400, { error: 'Stock must be an array' });
      writeJson('stock.json', stock);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/recognize' && req.method === 'POST') {
      const { image } = await readBody(req);
      const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(image || '');
      if (!m) return send(res, 400, { error: 'Send a JPEG/PNG/WebP data URL as "image".' });
      const text = await callClaude(
        [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
         { type: 'text', text: RECOGNIZE_PROMPT }],
        RECOGNIZE_SYSTEM, 1200);
      const parsed = extractJson(text);
      return send(res, 200, { items: Array.isArray(parsed.items) ? parsed.items : [] });
    }
    if (p === '/api/generate' && req.method === 'POST') {
      const { ingredients = [], notes = '' } = await readBody(req);
      if (!ingredients.length) return send(res, 400, { error: 'Pick at least one ingredient.' });
      const prompt =
        `Ingredients I have: ${ingredients.join(', ')}.\n` +
        (notes ? `Preferences: ${String(notes).slice(0, 500)}\n` : '') +
        'Assume salt, pepper, oil and water are available. Anything else not listed should be marked optional or kept minimal.\n' +
        'Reply exactly in this shape: {"title":"","emoji":"one emoji","description":"one sentence","servings":2,"time":"25 min",' +
        '"tags":["short tags"],"steps":[{"text":"imperative instruction","uses":[{"name":"ingredient","amount":number,"unit":"g|ml|tsp|tbsp|pcs|",' +
        '"optional":false}]}],"notes":"optional tip"}. List each ingredient in "uses" of the step where it is first needed, in cooking order.';
      const text = await callClaude(prompt, GENERATE_SYSTEM, 2500);
      const recipe = extractJson(text);
      if (!recipe.title || !Array.isArray(recipe.steps)) throw new Error('The AI reply was not a valid recipe.');
      recipe.id = 'gen-' + Date.now().toString(36);
      recipe.generated = true;
      return send(res, 200, recipe);
    }

    // Static files
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep) && file !== PUB) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  console.log('\n  🍳  Recepees is running\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On your phone:     http://${ip}:${PORT}   (same Wi-Fi)`);
  console.log(`\n  AI features: ${hasKey() ? 'ON (' + MODEL + ')' : 'OFF — set ANTHROPIC_API_KEY in .env'}\n`);
  console.log('  Anyone on your network can open this page. Stop it with Ctrl+C.\n');
});
