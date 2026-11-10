// Standalone Express entry point for self-hosting (Timeweb VPS). Lives in selfhost/ with its own package.json so
// Vercel (which reads only the root package.json) keeps its zero-config setup. The site has no login, so the API is
// protected by a per-IP hourly limit and a cap on parallel generations (each one boots an in-memory PostgreSQL).
import express from 'express';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const WORKER = path.join(__dirname, 'worker.js');

const MAX_PER_HOUR = Number(process.env.GENERATE_MAX_PER_HOUR || 30);
const MAX_PARALLEL = Number(process.env.GENERATE_MAX_PARALLEL || 1); // one generation can use ~450 MB on a 1 GB VPS
const WORKER_TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS || 100_000);

// Runs api/generate.js in a one-shot child process so the memory of the in-memory PostgreSQL is freed after each request.
function runInWorker(body) {
  return new Promise((resolve) => {
    const child = fork(WORKER, [], { env: process.env, execArgv: ['--max-old-space-size=300'] });
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); try { child.kill('SIGKILL'); } catch (_) { /* already gone */ } };
    const timer = setTimeout(() => finish({ status: 504, headers: {}, body: { error: 'timeout', message: 'Генерация заняла слишком много времени.' } }), WORKER_TIMEOUT_MS);
    child.once('message', (out) => finish(out));
    child.once('error', () => finish({ status: 500, headers: {}, body: { error: 'server_error', message: 'Внутренняя ошибка сервера.' } }));
    child.once('exit', () => finish({ status: 502, headers: {}, body: { error: 'worker_exit', message: 'Не удалось выполнить генерацию. Повторите запрос.' } }));
    child.send({ body });
  });
}
const hits = new Map(); // ip -> array of timestamps (ms) in the last hour
let running = 0;

function allow(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= MAX_PER_HOUR) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  return true;
}
setInterval(() => { // keep the map small
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 3600_000)) hits.delete(ip);
}, 600_000).unref();

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' })); // schema <= 30000 chars + question <= 2000

app.post('/api/generate', async (req, res) => {
  if (!allow(req.ip)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'rate_limited', message: `Слишком много запросов: не больше ${MAX_PER_HOUR} в час с одного адреса. Попробуйте позже.` });
  }
  if (running >= MAX_PARALLEL) {
    return res.status(503).json({ error: 'busy', message: 'Сервер сейчас занят другими запросами. Повторите через несколько секунд.' });
  }
  running++;
  try {
    const out = await runInWorker(req.body);
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    res.status(out.status || 200).json(out.body);
  } catch (e) {
    console.error('generate failed', e);
    if (!res.headersSent) res.status(500).json({ error: 'server_error', message: 'Внутренняя ошибка сервера.' });
  } finally { running--; }
});
app.all('/api/generate', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed', message: 'Используйте POST.' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Serve only the site files, never api/, selfhost/, package files or notes.
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(root, 'app.js')));
app.use('/fonts', express.static(path.join(root, 'fonts'), { maxAge: '30d', immutable: true }));
app.use('/vendor', express.static(path.join(root, 'vendor'), { maxAge: '30d', immutable: true }));
app.use('/samples', express.static(path.join(root, 'samples')));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 413 ? 'prompt_too_large' : 'server_error', message: status === 413 ? 'Запрос слишком большой.' : 'Внутренняя ошибка сервера.' });
});

const port = process.env.PORT || 3000;
app.listen(port, process.env.HOST || '127.0.0.1', () => console.log('listening on', port));
