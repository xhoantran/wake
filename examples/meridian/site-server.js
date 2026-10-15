// A tiny stand-in for a real website: static pages, a site search and an order endpoint.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml', '.css': 'text/css' };

function resolveFile(p) {
  const clean = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  const candidates = clean === '/' ? ['index.html'] : [clean.slice(1), clean.slice(1) + '.html'];
  for (const c of candidates) {
    const f = path.join(ROOT, c);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

function allPages() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.html')) out.push(f);
    }
  })(ROOT);
  return out.map((f) => {
    const html = fs.readFileSync(f, 'utf8');
    const rel = '/' + path.relative(ROOT, f).replace(/\.html$/, '').replace(/^index$/, '');
    return { path: rel, title: (html.match(/<title>([^<|]+)/) || [])[1]?.trim(), text: html.replace(/<[^>]+>/g, ' ').toLowerCase() };
  });
}

export function siteHandler(req, res) {
  {
    const url = new URL(req.url, 'http://site');
    if (url.pathname === '/search') {
      const words = (url.searchParams.get('q') || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const hits = allPages().map((p) => ({ ...p, score: words.filter((w) => p.text.includes(w)).length }))
        .filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(`<!doctype html><html><head><title>Search | Meridian Wireless</title></head><body><main><h1>Results</h1><ol>${
        hits.map((h) => `<li><a href="${h.path || '/'}">${h.title}</a></li>`).join('')}</ol></main></body></html>`);
    }
    if (url.pathname === '/checkout/order' && req.method === 'POST') {
      req.resume();
      res.writeHead(201, { 'content-type': 'application/json', 'x-wake-value': '8352' });
      return res.end(JSON.stringify({ order: '40-118-2275', lines: 4 }));
    }
    const file = resolveFile(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      return res.end('<!doctype html><html><head><title>Not found</title></head><body><main><h1>Page not found</h1><a href="/">Home</a></main></body></html>');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }
}

export function createSite() {
  return http.createServer(siteHandler);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4000);
  createSite().listen(port, '127.0.0.1', () => console.log(`Meridian example site on http://127.0.0.1:${port}`));
}
