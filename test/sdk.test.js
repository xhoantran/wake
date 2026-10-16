// The Datadog-style setup: the SDK runs inside the customer's app or CDN account, the collector is ours.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSite, siteHandler } from '../examples/meridian/site-server.js';
import baseConfig from '../examples/meridian/wake.config.js';
import { createCollector } from '../src/collector.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/node.js';
import { createTelemetry } from '../src/sdk/telemetry.js';
import { wakeMiddleware } from '../adapters/node.js';
import { createWorker, withWake } from '../adapters/worker.js';
import { wakeNext } from '../adapters/next.js';
import { tokenFrom } from './helpers.js';

const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const SAFARI = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1';
const KEY = 'wk_test_123';
const cfg = (extra = {}) => ({ ...structuredClone(baseConfig), mode: 'route', brief: { enabled: false }, ...extra });

let collector, collectorServer, C, site, S;
const servers = [];

before(async () => {
  collector = createCollector({ config: cfg(), store: openStore(':memory:'), apiKeys: [KEY] });
  collectorServer = await serve(collector, { port: 0 });
  C = `http://127.0.0.1:${collectorServer.address().port}`;
  site = createSite();
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  S = `http://127.0.0.1:${site.address().port}`;
});
after(() => { for (const s of [collectorServer, site, ...servers]) s.close(); });

/** A customer's Node app: the example site behind the Wake middleware. */
async function app(middlewareOptions) {
  const mw = wakeMiddleware(middlewareOptions);
  const server = http.createServer((req, res) => mw(req, res, () => siteHandler(req, res)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, mw };
}

const capture = () => ({ events: [], emit(e) { this.events.push(e); }, flush: async () => {} });
const get = (base, p, { ua = CHATGPT, headers = {} } = {}) => fetch(base + p, { redirect: 'manual', headers: { 'user-agent': ua, ...headers } });

test('middleware in the customer app sends a whole journey to the collector', async () => {
  const telemetry = createTelemetry({ endpoint: C, apiKey: KEY, flushMs: 0 });
  const { url } = await app({ config: cfg(), telemetry });

  let r = await get(url, '/plans/family');
  const code = r.headers.get('x-wake-session');
  let html = await r.text();
  let token = tokenFrom(html, code);
  assert.ok(html.includes(`href="/a/${token}/compare/crestline"`));

  r = await get(url, `/a/${token}/search?q=${encodeURIComponent('family plan mexico travel')}`);
  token = tokenFrom(await r.text(), code);
  r = await get(url, `/a/${token}/travel/international-pass`);
  html = await r.text();
  assert.ok(['mexico-first', 'mexico-first (holdout)'].includes(r.headers.get('x-wake-rules')));

  // A person never sees Wake: the same page, untouched.
  const plain = await (await get(url, '/plans/family', { ua: SAFARI })).text();
  assert.equal(plain, await (await fetch(S + '/plans/family')).text());

  // The person opens the agent's link and orders.
  r = await get(url, `/r/${token}/signup`, { ua: SAFARI });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  r = await fetch(url + '/checkout/order', { method: 'POST', body: 'x', headers: { 'user-agent': SAFARI, cookie } });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 50)); // 'finish' handlers run after the response
  await telemetry.flush();
  assert.equal(telemetry.stats.dropped, 0);

  const d = await (await fetch(`${C}/_wake/api/sessions/${code}`)).json();
  const types = d.events.map((e) => e.type);
  for (const t of ['fetch', 'handoff', 'conversion']) assert.ok(types.includes(t), `collector has ${t}`);
  assert.equal(d.session.conversion_value, 8352);
  assert.ok(d.session.intents.some((i) => i.id === 'travel'));
});

test('if the collector is down, the site keeps serving and events are dropped', async () => {
  const telemetry = createTelemetry({ endpoint: 'http://127.0.0.1:9', apiKey: KEY, flushMs: 0, timeoutMs: 500 });
  const { url } = await app({ config: cfg(), telemetry });
  const r = await get(url, '/plans/family');
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('/a/MW-'), 'agent page still rewritten');
  await telemetry.flush();
  assert.ok(telemetry.stats.dropped >= 1);
  assert.equal(telemetry.stats.sent, 0);
});

test('remote config: requests pass through until the config arrives, then Wake applies it', async () => {
  const { url, mw } = await app({ endpoint: C, apiKey: KEY, flushMs: 0 });
  // The first pull may still be in flight; either way the page must work.
  const first = await get(url, '/plans/family');
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(typeof mw, 'function');
  // Wait for the background pull, then a fresh agent read is tracked.
  await new Promise((r) => setTimeout(r, 100));
  const r = await get(url, '/plans/family');
  assert.match(r.headers.get('x-wake-session') || '', /^MW-/);
  await r.text();
});

test('collector rejects wrong keys and never hands out the dashboard token', async () => {
  const bad = await fetch(`${C}/v1/events`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{"events":[]}' });
  assert.equal(bad.status, 401);
  const withToken = createCollector({ config: cfg({ dashboard: { token: 'secret-dash' } }), store: openStore(':memory:'), apiKeys: [KEY] });
  const r = await withToken.handle(new Request('http://c/v1/config', { headers: { authorization: `Bearer ${KEY}` } }), { ip: '1.2.3.4' });
  const body = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!body.includes('secret-dash') && !body.includes('answerChecks'));
  assert.ok(JSON.parse(body).rules.length === 3);
});

test('kill switch: everything passes through and session URLs go to the clean page', async () => {
  const t = capture();
  const { url } = await app({ config: cfg({ enabled: false }), telemetry: t });
  let r = await get(url, '/plans/family');
  assert.equal(r.headers.get('x-wake-session'), null);
  assert.equal(await r.text(), await (await fetch(S + '/plans/family')).text());
  r = await get(url, '/a/MW-ABCDEF.3/plans/family');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/plans/family');
  assert.equal(t.events.length, 0);
});

test('trace mode: sessions and links, but no content rules and no redirects for guessed URLs', async () => {
  const t = capture();
  const { url } = await app({ config: cfg({ mode: 'trace' }), telemetry: t });
  let r = await get(url, '/a/MW-TRACE1.33/travel/international-pass');
  const html = await r.text();
  assert.equal(r.headers.get('x-wake-rules'), null);
  assert.ok(html.indexOf('$10 a day') < html.indexOf('Mexico and Canada are included'), 'page order untouched');
  assert.ok(html.includes('/a/MW-TRACE1.'), 'links still carry the session');
  r = await get(url, '/a/MW-TRACE1/plans/international-roaming');
  assert.equal(r.status, 404);
  const nf = t.events.find((e) => e.type === 'not_found');
  assert.equal(nf.data.suggestion, '/travel/international-pass', 'the guess and the likely page are still reported');
});

test('fail open: an error while rewriting returns the original page', async () => {
  const t = capture();
  const { url } = await app({ config: cfg({ transform: () => { throw new Error('boom'); } }), telemetry: t });
  const r = await get(url, '/plans/family');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), await (await fetch(S + '/plans/family')).text());
  assert.equal(t.events.find((e) => e.type === 'error').data.message, 'boom');
});

test('Cloudflare Worker adapter', async () => {
  const t = capture();
  const toSite = (req) => fetch(S + new URL(req.url).pathname + new URL(req.url).search, { method: req.method, headers: req.headers, redirect: 'manual' });
  const worker = createWorker({ config: cfg(), telemetry: t, fetch: toSite });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const req = (p, ua = CHATGPT) => new Request('https://www.meridian.example' + p, { headers: { 'user-agent': ua, 'cf-connecting-ip': '20.1.2.3' } });

  let r = await worker.fetch(req('/plans/family'), {}, ctx);
  const html = await r.text();
  const code = r.headers.get('x-wake-session');
  assert.ok(html.includes(`href="/a/${code}.3/compare/crestline"`));
  assert.ok(pending.length >= 1, 'telemetry flush handed to waitUntil');
  assert.equal(t.events[0].ipHash.length, 8, 'IPs are hashed before they leave');

  r = await worker.fetch(req('/plans/family', SAFARI), {}, ctx);
  assert.equal(await r.text(), await (await fetch(S + '/plans/family')).text(), 'people get the origin page');

  r = await worker.fetch(req('/plans/family'), { WAKE_DISABLED: '1' }, ctx);
  assert.equal(r.headers.get('x-wake-session'), null, 'kill switch from env');
  await Promise.all(pending);
});

test('Next.js middleware adapter', async () => {
  const t = capture();
  const seen = [];
  const selfFetch = async (request) => {
    seen.push(request.headers.get('x-wake-bypass'));
    return fetch(S + new URL(request.url).pathname, { redirect: 'manual' });
  };
  const wake = wakeNext({ config: cfg(), telemetry: t, fetch: selfFetch, bypassSecret: 'bypass-1' });
  const waits = [];
  const event = { waitUntil: (p) => waits.push(p) };
  const req = (p, ua = CHATGPT, headers = {}) => new Request('https://www.meridian.example' + p, { headers: { 'user-agent': ua, ...headers } });

  assert.equal(await wake(req('/plans/family', SAFARI), event), undefined, 'people: Next serves the page');
  const r = await wake(req('/plans/family'), event);
  assert.ok(r instanceof Response);
  assert.ok((await r.text()).includes('/a/MW-'));
  assert.deepEqual(seen, ['bypass-1'], 'the self-fetch carries the bypass header');
  assert.equal(await wake(req('/plans/family', CHATGPT, { 'x-wake-bypass': 'bypass-1' }), event), undefined, 'the self-fetch is let through');

  const handoff = await wake(req(`/r/${r.headers.get('x-wake-session')}/signup`, SAFARI), event);
  assert.equal(handoff.status, 302);
  const cookie = handoff.headers.getSetCookie()[0].split(';')[0];
  assert.ok(wake.conversion(req('/api/order', SAFARI, { cookie }), { name: 'order', value: 99 }));
  assert.equal(t.events.at(-1).type, 'conversion');
  await Promise.all(waits);
});

test('telemetry batches, caps its buffer and never throws', async () => {
  const posts = [];
  const ok = createTelemetry({ endpoint: 'http://c', apiKey: 'k', flushMs: 0, maxBatch: 2, fetch: async (_u, init) => { posts.push(JSON.parse(init.body).events.length); return new Response('{}'); } });
  for (let i = 0; i < 5; i++) ok.emit({ i });
  await ok.flush();
  assert.deepEqual(posts.reduce((a, b) => a + b, 0), 5);
  assert.ok(posts.every((n) => n <= 2));

  const broken = createTelemetry({ endpoint: 'http://c', apiKey: 'k', flushMs: 0, maxBatch: 1000, maxBuffer: 3, fetch: async () => { throw new Error('down'); } });
  for (let i = 0; i < 5; i++) broken.emit({ i });
  assert.equal(broken.pending(), 3);
  await broken.flush();
  assert.equal(broken.stats.dropped, 5);
});

test('withWake wraps an existing Worker: off without a key, byte-identical in shadow mode, config from the collector', async () => {
  const PAGE = '<html><body><a href="/managed">Managed</a> code NW-ABC123</body></html>';
  let calls = 0;
  const app = { async fetch(request, env, ctx) { calls++; return new Response(PAGE, { headers: { 'content-type': 'text/html', 'x-app': 'landing' } }); } };
  const req = (ua) => new Request('https://www.new-wave.ai/managed', { headers: { 'user-agent': ua, 'cf-connecting-ip': '20.1.1.1' } });

  // No key: Wake is not involved at all.
  const off = withWake(app);
  assert.equal(await (await off.fetch(req(CHATGPT), {}, { waitUntil() {} })).text(), PAGE);
  assert.equal(calls, 1);

  // With a key: the config comes from the collector; the first request passes through while it loads.
  const sent = [];
  const collectorFetch = async (url, init) => {
    if (String(url).endsWith('/v1/config')) return Response.json({ mode: 'shadow', intents: [{ id: 'managed', label: 'Managed', paths: ['/managed'] }], version: 3 });
    sent.push(...JSON.parse(init.body).events);
    return new Response('{}', { status: 202 });
  };
  const wrapped = withWake(app, { fetch: collectorFetch });
  const env = { WAKE_API_KEY: 'wk_live_test', WAKE_ENDPOINT: 'https://wake.example' };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  let r = await wrapped.fetch(req(CHATGPT), env, ctx);
  assert.equal(await r.text(), PAGE);
  await Promise.all(pending.splice(0));

  r = await wrapped.fetch(req(CHATGPT), env, ctx);
  assert.equal(await r.text(), PAGE, 'shadow mode returns exactly what the app returned');
  assert.equal(r.headers.get('x-app'), 'landing');
  assert.equal(r.headers.get('x-wake-session'), null);
  await Promise.all(pending.splice(0));
  const read = sent.find((e) => e.type === 'fetch');
  assert.equal(read.path, '/managed');
  assert.equal(read.data.shadow, true);

  // People pass straight through and nothing is sent for them.
  const before = sent.length;
  assert.equal(await (await wrapped.fetch(req(SAFARI), env, ctx)).text(), PAGE);
  await Promise.all(pending.splice(0));
  assert.equal(sent.length, before);

  // Kill switch from the Worker's settings.
  assert.equal(await (await wrapped.fetch(req(CHATGPT), { ...env, WAKE_DISABLED: '1' }, ctx)).text(), PAGE);
});
