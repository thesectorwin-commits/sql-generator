// One-shot worker: runs api/generate.js for a single request in its own process and exits, so the ~400 MB that the
// in-memory PostgreSQL (PGlite/WASM) grows to is returned to the OS after every request instead of staying resident.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('../api/generate.js');

process.once('message', async ({ body }) => {
  const out = { status: 200, headers: {}, body: null };
  let sent = false;
  const finish = () => { if (sent) return; sent = true; process.send(out, () => process.exit(0)); };
  const res = {
    setHeader(k, v) { out.headers[k] = v; return res; },
    status(code) { out.status = code; return res; },
    json(obj) { out.body = obj; finish(); return res; }
  };
  try {
    await handler({ method: 'POST', body, headers: {} }, res);
    if (!sent) { out.status = 500; out.body = { error: 'server_error', message: 'Пустой ответ обработчика.' }; finish(); }
  } catch (e) {
    console.error('worker failed', e && e.message);
    out.status = 500; out.body = { error: 'server_error', message: 'Внутренняя ошибка сервера.' }; finish();
  }
});
