import http from 'node:http';
import { Readable } from 'node:stream';

/**
 * Adapt a Wake instance to Node's http server.
 * trustProxy: read the client IP and protocol from X-Forwarded-* (only behind a proxy you control).
 */
export function toNodeHandler(wake, { trustProxy = false } = {}) {
  return async (req, res) => {
    try {
      const proto = (trustProxy && req.headers['x-forwarded-proto']) || 'http';
      const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
        else if (v != null) headers.set(k, v);
      }
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
      const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
      const response = await wake.handle(new Request(url, init), { ip });
      res.statusCode = response.status;
      response.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end('Wake error: ' + err.message);
    }
  };
}

export function serve(wake, { port = 8787, host = '127.0.0.1', trustProxy = false } = {}) {
  const server = http.createServer(toNodeHandler(wake, { trustProxy }));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
