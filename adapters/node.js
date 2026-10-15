// Connect-style middleware for Node servers (Express, Connect, Polka, plain http).
//   import { wakeMiddleware } from 'wake/node-middleware';
//   app.use(wakeMiddleware({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.wake.dev' }));
// People and search engines pass straight through. Only live AI agents' responses are buffered and rewritten.
// Any error inside Wake falls back to the app's own response.
import { buildCore } from './shared.js';

const NULL_BODY = new Set([101, 204, 205, 304]);

function headersOf(req) {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
    else if (v != null) h.set(k, v);
  }
  return h;
}

function resHeaders(res) {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.getHeaders())) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, String(x)));
    else if (v != null) h.set(k, String(v));
  }
  return h;
}

/** Let the rest of the app write its response into a buffer instead of the socket. */
function capture(res, run) {
  return new Promise((resolve) => {
    const chunks = [];
    const orig = { write: res.write, end: res.end, writeHead: res.writeHead };
    const toBuf = (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : undefined));
    res.writeHead = function (status, a, b) {
      res.statusCode = status;
      const h = a && typeof a === 'object' ? a : b;
      if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
      return res;
    };
    res.write = function (chunk, enc, cb) {
      if (chunk != null) chunks.push(toBuf(chunk, enc));
      (typeof enc === 'function' ? enc : cb)?.();
      return true;
    };
    res.end = function (chunk, enc, cb) {
      if (chunk != null && typeof chunk !== 'function') chunks.push(toBuf(chunk, enc));
      Object.assign(res, orig);
      resolve(Buffer.concat(chunks));
      (typeof chunk === 'function' ? chunk : typeof enc === 'function' ? enc : cb)?.();
      return res;
    };
    run();
  });
}

function send(res, response, body) {
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(body);
}

export function wakeMiddleware(options = {}) {
  const core = options.core || buildCore(options);
  const trustProxy = options.trustProxy ?? true;

  return function wake(req, res, next) {
    let request, c;
    try {
      const proto = (trustProxy && req.headers['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
      request = new Request(`${proto}://${req.headers.host || 'localhost'}${req.originalUrl || req.url}`, { method: req.method, headers: headersOf(req) });
      const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress;
      c = core.classify(request, { ip });
    } catch {
      return next();
    }

    if (c.kind === 'pass') return next();
    if (c.kind === 'respond') return send(res, c.response, null);
    if (c.kind === 'human' || c.kind === 'bot') {
      // Headers passed straight to writeHead() never show up in getHeaders(), so note them on the way out.
      const written = new Headers();
      const writeHead = res.writeHead;
      res.writeHead = function (status, a, b) {
        const h = a && typeof a === 'object' ? a : b;
        if (h && !Array.isArray(h)) for (const [k, v] of Object.entries(h)) if (v != null) written.set(k, String(v));
        return writeHead.apply(this, arguments);
      };
      res.on('finish', () => {
        const headers = resHeaders(res);
        written.forEach((v, k) => { if (!headers.has(k)) headers.set(k, v); });
        core.finishObserved(c.ctx, { status: res.statusCode, headers });
      });
      return next();
    }

    // Live agent: let the app render the clean path, then rewrite its response.
    req.url = c.path;
    capture(res, next).then(async (body) => {
      const status = res.statusCode;
      const original = new Response(NULL_BODY.has(status) ? null : body, { status, headers: resHeaders(res) });
      let out;
      try { out = await core.finishAgent(c.ctx, original); } catch { out = null; }
      if (!out) return send(res, new Response(null, { status, headers: resHeaders(res) }), body);
      send(res, out, NULL_BODY.has(out.status) ? null : Buffer.from(await out.arrayBuffer()));
    }).catch(() => { if (!res.headersSent) res.end(); });
  };
}

/** Report a conversion from your own route: wake.conversion(req, { name: 'order', value: 120 }). */
export function conversion(core, req, data) {
  const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, { headers: headersOf(req) });
  return core.conversion(request, data);
}
