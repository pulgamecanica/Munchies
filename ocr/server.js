// OCR microservice: POST raw image bytes -> { text }. Tesseract CLI, no npm packages.
// Internal only (no published port): the gateway is the only caller.
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8884;
const LANGS = process.env.OCR_LANGS || 'eng+fra';
const MAX = Number(process.env.OCR_MAX_BYTES) || 15 * 1024 * 1024;
const SLOTS = Number(process.env.OCR_CONCURRENCY) || os.availableParallelism();
let busy = 0;

const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  if (req.method === 'GET') return reply(res, 200, { ok: true, langs: LANGS, busy, slots: SLOTS });
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST an image' });
  // ponytail: reject when full instead of queueing; the gateway falls back to vision. Add a queue if 503s show up.
  if (busy >= SLOTS) return reply(res, 503, { error: 'busy' });
  const lang = new URL(req.url, 'http://x').searchParams.get('lang') || LANGS;
  if (!/^[a-z_]{3,10}(\+[a-z_]{3,10})*$/.test(lang)) return reply(res, 400, { error: 'bad lang' });

  busy++;
  let size = 0, out = '', err = '', done = false;
  const finish = (status, body) => { if (done) return; done = true; busy--; reply(res, status, body); };
  // OMP_THREAD_LIMIT=1: one thread per job is faster overall when jobs run in parallel.
  const t = spawn('tesseract', ['stdin', 'stdout', '-l', lang, '--psm', '3'], { timeout: 60000, env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
  t.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
  t.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  t.on('error', (e) => finish(500, { error: e.message }));
  t.on('close', (code) => (code === 0 ? finish(200, { text: out.trim() }) : finish(422, { error: err.trim().split('\n').pop() || 'OCR failed' })));
  t.stdin.on('error', () => {}); // tesseract may exit before reading everything
  req.on('data', (c) => { size += c.length; if (size > MAX) { t.kill(); finish(413, { error: 'too large' }); req.destroy(); } });
  req.pipe(t.stdin);
}).listen(PORT, () => console.log(`OCR on :${PORT} (${LANGS}, ${SLOTS} parallel)`));
