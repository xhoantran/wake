// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
import { unauthorized } from '../src/dashboard.js';

/** The hosted collector's front page: the sites an organization link opens (or every site, on localhost without a secret). */
export async function handleIndex(request, { url, base, tenants, secret, local, readCookies }) {
  const linkToken = url.searchParams.get('token');
  const linkClaims = tenants.verifyToken(linkToken);
  if (linkClaims?.o) {
    const secure = url.protocol === 'https:' ? '; Secure' : '';
    return new Response(null, { status: 302, headers: { location: base + '/', 'set-cookie': `wake_dash=${linkToken}; Path=${base}; HttpOnly; SameSite=Strict${secure}` } });
  }
  if (linkClaims?.s) return new Response(null, { status: 302, headers: { location: `${base}/sites/${linkClaims.s}/?token=${encodeURIComponent(linkToken)}` } });
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const org = [auth, ...readCookies(request, 'wake_dash')].map((t) => tenants.verifyToken(t)).find((c) => c?.o)?.o;
  if (!org && !local) return unauthorized({ secret });
  const sites = await tenants.listSites(org || undefined);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = sites.map((s) => `<li><a href="${base}/sites/${esc(s.id)}/">${esc(s.name)}</a> <span class="mono">${esc(s.id)}</span></li>`).join('');
  return new Response(INDEX.replace('{{sites}}', () => rows || '<li>No sites yet. Create one with <span class="mono">wake admin site create</span>.</li>'),
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const INDEX = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Wake sites</title>
<style>:root{--bg:#fbfbfc;--ink:#17181b;--ink3:#6a6c72;--accent:#2d62cf}@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--ink:#ededef;--ink3:#8f9096;--accent:#8cb0ff;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/22px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:720px;margin:0 auto;padding:32px 20px}
h1{font-size:18px}a{color:var(--accent)}li{margin:6px 0}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink3)}</style></head>
<body><main><h1>Wake</h1><ul>{{sites}}</ul></main></body></html>`;

