// `wake verify` against real installs (the example site behind the Node middleware, a real collector)
// and against broken ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { siteHandler } from '../examples/meridian/site-server.js';
import baseConfig from '../examples/meridian/wake.config.js';
import { createCollector } from '../src/collector.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/node.js';
import { createTelemetry } from '../src/sdk/telemetry.js';
import { wakeMiddleware } from '../adapters/node.js';
import { verifySite, formatReport, parseCarrierHeader, pageLinks, VERIFY_UA } from '../src/verify.js';
import { classifyAgent } from '../src/agents.js';

const KEY = 'wk_test_verify';
const cfg = (extra = {}) => ({ ...structuredClone(baseConfig), mode: 'trace', ...extra });
const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 60)));
const status = (r, id) => r.checks.find((c) => c.id === id)?.status;

let collector, collectorServer, C;
const servers = [];
before(async () => {
  collector = createCollector({ config: cfg(), store: openStore(':memory:'), apiKeys: [KEY] });
  collectorServer = await serve(collector, { port: 0 });
  C = `http://127.0.0.1:${collectorServer.address().port}`;
});
after(() => { for (const s of [collectorServer, ...servers]) s.close(); });

/** The example site behind the Wake middleware, reporting to the test collector. */
async function app(config, handler = siteHandler) {
  const telemetry = createTelemetry({ endpoint: C, apiKey: KEY, flushMs: 20 });
  const mw = wakeMiddleware({ config, telemetry });
  const server = http.createServer((req, res) => mw(req, res, () => handler(req, res)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('Wake-Verify is an honest user-agent that Wake treats as a live agent', () => {
  assert.deepEqual(classifyAgent(VERIFY_UA), { name: 'Wake verify', vendor: 'Wake', kind: 'live' });
  assert.ok(!/ChatGPT|Claude|Perplexity/.test(VERIFY_UA));
});

for (const carrier of ['path', 'query']) {
  test(`a correct install passes every check (${carrier} carrier), and the probe never becomes a session`, async () => {
    const url = await app(cfg({ carrier }));
    const before = (await (await fetch(`${C}/_wake/api/overview`)).json()).kpis.sessions;
    const r = await verifySite({ url: url + '/plans/family', endpoint: C, apiKey: KEY, sleep: fast });
    assert.equal(r.ok, true, formatReport(r));
    assert.equal(r.mode, 'trace');
    assert.equal(r.carrier, carrier);
    // The example config lists meridian.example as the site's own origin, so its links carry the code too.
    assert.equal(status(r, 'external-links'), 'warn');
    assert.match(r.checks.find((c) => c.id === 'external-links').detail, /meridian\.example .*sameSiteOrigins/);
    for (const id of ['reachable', 'people-untouched', 'sdk', 'session', 'links', 'private-cache', 'canonical', 'session-continues', 'crawlers-clean', 'handoff', 'collector']) {
      assert.equal(status(r, id), 'pass', `${id}: ${r.checks.find((c) => c.id === id)?.detail}`);
    }
    const after = (await (await fetch(`${C}/_wake/api/overview`)).json()).kpis.sessions;
    assert.equal(after, before, 'verify visits stay out of sessions and reports');

    const probe = await (await fetch(`${C}/v1/probes/${r.probe}`, { headers: { authorization: `Bearer ${KEY}` } })).json();
    assert.ok(probe.events.some((e) => e.type === 'handoff' && e.actor === 'human' && e.via === carrier));
  });
}

test('shadow mode: checks that nothing changes and skips the session checks', async () => {
  const url = await app(cfg({ mode: 'shadow' }));
  const r = await verifySite({ url: url + '/plans/family', endpoint: C, apiKey: KEY, sleep: fast });
  assert.equal(r.ok, true, formatReport(r));
  assert.equal(r.mode, 'shadow');
  assert.equal(status(r, 'shadow-untouched'), 'pass');
  assert.equal(status(r, 'session'), undefined);
  assert.equal(status(r, 'collector'), 'pass', 'shadow reads still reach the collector');
});

test('a site without Wake, or a collector that refuses the key, fails with a reason', async () => {
  const plain = http.createServer(siteHandler);
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  servers.push(plain);
  let r = await verifySite({ url: `http://127.0.0.1:${plain.address().port}/plans/family`, sleep: fast });
  assert.equal(r.ok, false);
  assert.equal(status(r, 'sdk'), 'fail');
  assert.match(r.checks.find((c) => c.id === 'sdk').detail, /WAKE_API_KEY/);
  assert.match(formatReport(r), /✗ Wake runs on this page/);

  const url = await app(cfg());
  r = await verifySite({ url: url + '/plans/family', endpoint: C, apiKey: 'wrong', sleep: fast });
  assert.equal(status(r, 'collector'), 'fail');
  assert.match(r.checks.find((c) => c.id === 'collector').detail, /refused the API key \(HTTP 401\)/);
  assert.equal(status(r, 'handoff'), 'pass', 'the site itself is fine');
});

test('probe results are only readable with the site API key', async () => {
  let r = await fetch(`${C}/v1/probes/VF-ABCDEFGH`);
  assert.equal(r.status, 401);
  r = await fetch(`${C}/v1/probes/not-a-probe`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(r.status, 400);
  r = await fetch(`${C}/v1/probes/VF-NOTHING1`, { headers: { authorization: `Bearer ${KEY}` } });
  assert.deepEqual((await r.json()).events, []);
});

test('a broken install: public caching, codes in the canonical URL and in outside links are caught', async () => {
  const code = 'WK-BROKE1';
  const page = `<html><head><link rel="canonical" href="https://shop.example/a/${code}/plans"></head><body>
    <a href="/a/${code}/plans">Plans</a> <a href="/about">About</a> <a href="https://other.example/x?wk=${code}">Partner</a></body></html>`;
  const fake = async (url, init) => {
    const ua = init.headers['user-agent'];
    if (!ua.includes('Wake-Verify')) return new Response('<html><body>hi</body></html>', { headers: { 'content-type': 'text/html' } });
    const first = new URL(url).pathname === '/plans'; // later pages lose the session
    return new Response(page, { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=600', 'x-wake-mode': 'trace',
      ...(first ? { 'x-wake-session': code } : {}), 'x-wake-carrier': 'path; prefix=/a; handoffPrefix=/r; param=wk; handoffParam=wkh' } });
  };
  const r = await verifySite({ url: 'https://shop.example/plans', fetch: fake, sleep: fast });
  assert.equal(r.ok, false);
  assert.equal(status(r, 'private-cache'), 'fail');
  assert.equal(status(r, 'canonical'), 'fail');
  assert.equal(status(r, 'external-links'), 'warn');
  assert.equal(status(r, 'links'), 'warn', 'one of two same-site links carries the code');
  assert.match(r.checks.find((c) => c.id === 'links').detail, /1 of 2 .*\/about/);
  assert.equal(status(r, 'session-continues'), 'fail', 'the next page did not keep the session');
  assert.equal(status(r, 'handoff'), 'skip');
  assert.equal(status(r, 'collector'), 'skip');
});

test('helpers: carrier header and page links', () => {
  assert.deepEqual(parseCarrierHeader('query; prefix=/w; handoffPrefix=/go; param=nw; handoffParam=nwh'),
    { carrier: 'query', prefix: '/w', handoffPrefix: '/go', param: 'nw', handoffParam: 'nwh' });
  assert.equal(parseCarrierHeader(null).carrier, null);
  const links = pageLinks('<a href="/x?a=1&amp;b=2">x</a><a href="mailto:a@b.c">m</a><form action="/f"><a>no href</a>', 'https://s.example/p');
  assert.deepEqual(links.map((l) => l.url.href), ['https://s.example/x?a=1&b=2', 'https://s.example/f']);
});
