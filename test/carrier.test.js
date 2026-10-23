// The session code can travel in the path (/a/{code}/page) or in a query parameter (/page?wk={code}).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../examples/meridian/site-server.js';
import baseConfig from '../examples/meridian/wake.config.js';
import { createWorker } from '../adapters/worker.js';
import { createCollector } from '../src/collector.js';
import { openStore } from '../src/store.js';
import { normalizeConfig } from '../src/config.js';
import { readSession, stripParams, setParam, getParam } from '../src/util.js';
import { makeUrlRewriter, rewriteHtml } from '../src/rewrite.js';
import { carrierFor } from '../src/sdk/core.js';

const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const SAFARI = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1';
const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; GPTBot/1.2; +https://openai.com/gptbot';
const cfg = (extra = {}) => ({ ...structuredClone(baseConfig), mode: 'trace', carrier: 'query', ...extra });

let site, S;
before(async () => {
  site = createSite();
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  S = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

/** The example site behind the Worker adapter. `seen` collects the URLs the site itself was asked for. */
function worker(config) {
  const events = [];
  const seen = [];
  const toSite = (req) => {
    const u = new URL(req.url);
    seen.push(u.pathname + u.search);
    return fetch(S + u.pathname + u.search, { method: req.method, headers: req.headers, redirect: 'manual' });
  };
  const w = createWorker({ config, telemetry: { emit: (e) => events.push(e), flush: async () => {} }, fetch: toSite });
  const get = (p, ua = CHATGPT, headers = {}) => w.fetch(new Request('https://www.meridian.example' + p,
    { headers: { 'user-agent': ua, 'cf-connecting-ip': '20.1.2.3', ...headers }, redirect: 'manual' }), {}, { waitUntil() {} });
  return { get, events, seen };
}

const queryToken = (text, code) => (text.match(new RegExp(`[?&](?:amp;)?wk=(${code}(?:\\.[0-9a-z]+)?)`)) || [])[1];

test('query helpers keep the rest of the query exactly as written', () => {
  assert.equal(stripParams('?b=1%202&wk=WK-ABCD12&flag&a=x+y', ['wk']), '?b=1%202&flag&a=x+y');
  assert.equal(stripParams('?wk=WK-ABCD12', ['wk']), '');
  assert.equal(setParam('?wk=old&q=1', 'wk', 'WK-ABCD12.3'), '?q=1&wk=WK-ABCD12.3');
  assert.equal(setParam('', 'wk', 'WK-ABCD12'), '?wk=WK-ABCD12');
  assert.equal(getParam('?a=1&flag&wk=WK-ABCD12.3a', 'wk'), 'WK-ABCD12.3a');
  assert.equal(getParam('?flag', 'flag'), '');
  assert.equal(getParam('?a=1', 'wk'), null);
});

test('readSession finds the code in the path or the query', () => {
  const c = normalizeConfig(cfg());
  const r = (u) => readSession(new URL('https://x.example' + u), c);
  let s = r('/a/WK-ABCD12.3/plans?x=1&wk=WK-ZZZZ99');
  assert.equal(s.pre.code, 'WK-ABCD12');
  assert.equal(s.pre.via, 'path');
  assert.equal(s.cleanPath, '/plans');
  assert.equal(s.cleanSearch, '?x=1', 'a stray query code is dropped too');
  s = r('/plans?x=1&wk=WK-ABCD12.3');
  assert.deepEqual([s.pre.code, s.pre.state, s.pre.via, s.cleanPath, s.cleanSearch], ['WK-ABCD12', '3', 'query', '/plans', '?x=1']);
  s = r('/signup?wkh=WK-ABCD12.3&plan=4');
  assert.deepEqual([s.ho.code, s.ho.via, s.cleanPath, s.cleanSearch], ['WK-ABCD12', 'query', '/signup', '?plan=4']);
  s = r('/plans?wk=not-a-code');
  assert.equal(s.pre, null);
  assert.equal(s.cleanSearch, '', 'an invalid code is still not passed to the site');
});

test('query rewriter: same-site links get ?wk=, sign-up links get ?wkh=, everything else is left alone', () => {
  const c = normalizeConfig(cfg());
  const rw = makeUrlRewriter({ code: 'WK-ABCD12.3', carrier: 'query', prefix: c.prefix, handoffPrefix: c.handoffPrefix, param: c.param, handoffParam: c.handoffParam,
    handoffPaths: c.handoffPaths, skipPaths: [], cleanPath: '/plans/family', requestOrigin: 'https://www.meridian.example',
    upstreamOrigin: 'https://www.meridian.example', sameOrigins: new Set(['https://www.meridian.example', 'https://meridian.example']) });
  assert.equal(rw('/travel/international-pass'), '/travel/international-pass?wk=WK-ABCD12.3');
  assert.equal(rw('../compare/crestline#price'), '/compare/crestline?wk=WK-ABCD12.3#price');
  assert.equal(rw('/search?q=mexico'), '/search?q=mexico&wk=WK-ABCD12.3');
  assert.equal(rw('https://meridian.example/about'), 'https://meridian.example/about?wk=WK-ABCD12.3');
  assert.equal(rw('/signup'), '/signup?wkh=WK-ABCD12.3');
  assert.equal(rw('https://example.org/elsewhere'), 'https://example.org/elsewhere');
  assert.equal(rw('/style.css'), '/style.css');
  assert.equal(rw('/plans?wk=WK-OTHER1'), '/plans?wk=WK-OTHER1', 'already carries a code');
  assert.equal(rw('/a/WK-OTHER1/plans'), '/a/WK-OTHER1/plans');
  assert.equal(rewriteHtml('<a href="/signup?plan=x&amp;lines=4">Order</a>', rw), '<a href="/signup?plan=x&amp;lines=4&amp;wkh=WK-ABCD12.3">Order</a>');
  assert.equal(rewriteHtml('<a href="https://example.org/?a=1&amp;b=2">x</a>', rw), '<a href="https://example.org/?a=1&amp;b=2">x</a>', 'untouched links keep their spelling');
});

test('query carrier end to end: the site never sees the parameter, the session follows the links, the person is credited', async () => {
  const { get, events, seen } = worker(cfg());
  let r = await get('/plans/family');
  const code = r.headers.get('x-wake-session');
  let html = await r.text();
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  let token = queryToken(html, code);
  assert.ok(token, 'links carry ?wk=');
  assert.ok(html.includes(`href="/travel/international-pass?wk=${token}"`));
  assert.ok(!html.includes('/a/' + code), 'no path codes in query mode');
  assert.ok(html.includes(`<link rel="canonical" href="https://www.meridian.example/plans/family">`) || /rel="canonical" href="[^"?]+"/.test(html), 'canonical stays clean');

  r = await get(`/search?q=${encodeURIComponent('mexico travel')}&wk=${token}`);
  assert.equal(r.headers.get('x-wake-session'), code, 'same session');
  assert.equal(seen.at(-1), `/search?q=${encodeURIComponent('mexico travel')}`, 'the site gets the clean URL');
  token = queryToken(await r.text(), code) || token;

  // The agent checks the sign-up link before sharing it: not a hand-off, and it stays in the query form.
  r = await get(`/signup?wkh=${token}`);
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), `/signup?wk=${token}`);

  // The person opens it.
  r = await get(`/signup?plan=4&wkh=${token}`, SAFARI);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signup?plan=4');
  assert.match(r.headers.getSetCookie()[0], new RegExp(`wake_sid=${code}`));
  const ho = events.find((e) => e.type === 'handoff');
  assert.equal(ho.code, code);
  assert.equal(ho.data.via, 'query');
  assert.ok(events.filter((e) => e.type === 'fetch').every((e) => e.data.carrier === 'query'));

  // Search engines are sent to the clean URL; a person who opens a forwarded agent link is credited once.
  r = await get(`/plans/family?wk=${token}`, GPTBOT);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/plans/family');
  r = await get(`/plans/family?wk=${token}`, SAFARI);
  assert.equal(r.status, 302);
  assert.equal(events.filter((e) => e.type === 'shared').at(-1).data.via, 'query');
});

test('links in the other form keep working after a switch, and the kill switch strips both', async () => {
  const q = worker(cfg());
  let r = await q.get('/a/WK-ABCD12.3/plans/family');
  assert.equal(r.headers.get('x-wake-session'), 'WK-ABCD12', 'an old path link resumes its session');
  assert.ok((await r.text()).includes('?wk=WK-ABCD12'), 'and continues in the query form');

  const p = worker(cfg({ carrier: 'path' }));
  r = await p.get('/plans/family?wk=WK-ABCD12.3');
  assert.equal(r.headers.get('x-wake-session'), 'WK-ABCD12');
  assert.ok((await r.text()).includes('href="/a/WK-ABCD12'));
  assert.equal(p.seen.at(-1), '/plans/family');

  const off = worker(cfg({ enabled: false }));
  r = await off.get('/plans/family?x=1&wk=WK-ABCD12', SAFARI);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/plans/family?x=1');
});

test('split: each session keeps one carrier, and the dashboard compares them', async () => {
  const c = normalizeConfig(cfg({ carrier: 'split' }));
  const arms = Array.from({ length: 400 }, (_, i) => carrierFor(c, `WK-T${String(i).padStart(5, '0')}`));
  const share = arms.filter((a) => a === 'query').length / arms.length;
  assert.ok(share > 0.4 && share < 0.6, `about half the sessions use the query (${share})`);
  assert.equal(carrierFor(c, 'WK-T00001'), carrierFor(c, 'WK-T00001'));

  const { get, events } = worker(cfg({ carrier: 'split' }));
  for (let i = 0; i < 12; i++) {
    const r = await get('/plans/family');
    const code = r.headers.get('x-wake-session');
    const html = await r.text();
    const carrier = carrierFor(c, code);
    assert.equal(html.includes(`?wk=${code}`), carrier === 'query');
    assert.equal(html.includes(`/a/${code}`), carrier === 'path');
  }
  const fetches = events.filter((e) => e.type === 'fetch');
  assert.ok(fetches.every((e) => e.data.exposures?.[0]?.rule === 'link-carrier' && e.data.exposures[0].arm === e.data.carrier));

  // Two sessions, one per arm, one hand-off: the report shows the comparison.
  const collector = createCollector({ config: cfg({ carrier: 'split' }), store: openStore(':memory:') });
  await collector.ready;
  const byArm = { query: fetches.find((e) => e.data.carrier === 'query'), path: fetches.find((e) => e.data.carrier === 'path') };
  await collector.ingest([byArm.query, byArm.path, { ts: Date.now(), code: byArm.query.code, type: 'handoff', actor: 'human', path: '/signup', status: 302, data: { via: 'query' } }]);
  const o = await (await collector.handle(new Request('http://127.0.0.1/_wake/api/overview'), { ip: '127.0.0.1' })).json();
  const e = o.experiments.find((x) => x.id === 'link-carrier');
  assert.deepEqual(e.arms, ['Query', 'Path']);
  assert.equal(e.routed.n, 1);
  assert.equal(e.routed.handoffs, 1);
  assert.equal(e.holdout.n, 1);
  assert.equal(e.holdout.handoffs, 0);
});

test('carrier settings are checked', () => {
  assert.throws(() => normalizeConfig({ carrier: 'cookie' }), /carrier must be path, query or split/);
  assert.throws(() => normalizeConfig({ param: 'w k' }), /param must be a short name/);
  assert.throws(() => normalizeConfig({ param: 'wk', handoffParam: 'wk' }), /must differ/);
  assert.throws(() => normalizeConfig({ rules: [{ id: 'link-carrier', promote: 'x' }], blocks: { x: 'X' } }), /reserved/);
  assert.equal(normalizeConfig({}).carrier, 'path', 'the default is unchanged');
});
