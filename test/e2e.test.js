// End to end: a real site server, Wake in front of it over HTTP, and scripted agents and people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../examples/meridian/site-server.js';
import baseConfig from '../examples/meridian/wake.config.js';
import { createWake } from '../src/wake.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/node.js';
import { unitHash } from '../src/util.js';
import { tokenFrom, walk } from './helpers.js';

const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';

let site, proxy, wake, W;

before(async () => {
  site = createSite();
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${site.address().port}`;
  wake = createWake({ ...structuredClone(baseConfig), upstream }, { store: openStore(':memory:') });
  proxy = await serve(wake, { port: 0, trustProxy: true });
  W = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => { proxy.close(); site.close(); });

function get(path, { ua = CHATGPT, ip = '20.0.0.1', headers = {}, method = 'GET', body } = {}) {
  return fetch(W + path, { method, body, redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip, ...headers } });
}

/** Pick a session code whose holdout assignment for a rule is known, so the test is deterministic. */
function codeFor(rule, arm, holdout = 0.2) {
  for (let i = 0; i < 10000; i++) {
    const code = `MW-TEST${String(i).padStart(4, '0')}`;
    if ((unitHash(`${code}:${rule}`) < holdout) === (arm === 'holdout')) return code;
  }
}

test('one agent journey from first read to an order', async () => {
  // 1. First read mints a session and rewrites links.
  let r = await get('/plans/family', { ip: '20.0.0.9' });
  assert.equal(r.status, 200);
  const minted = r.headers.get('x-wake-session');
  assert.match(minted, /^MW-[A-Z0-9]{6}$/);
  let html = await r.text();
  const t1 = tokenFrom(html, minted);
  assert.equal(t1, `${minted}.3`, 'links carry the code plus the session state (family plan intent = 3)');
  assert.ok(html.includes(`href="/a/${t1}/compare/crestline"`), 'relative link carries the token');
  assert.ok(html.includes(`href="/r/${t1}/signup?plan=unlimited-plus&amp;lines=4"`), 'sign-up link becomes a handoff link');
  assert.ok(html.includes('href="/style.css"'), 'assets are untouched');
  assert.ok(html.includes('href="https://twitter.com/example"'), 'external links are untouched');
  assert.ok(html.includes(`href="https://meridian.example/a/${t1}/about"`), 'absolute same-site links carry the token');
  assert.ok(html.includes('<link rel="canonical" href="'), 'canonical link added');

  // Use a code with a known routed assignment for the rest of the journey, following links like an agent.
  const code = codeFor('mexico-first', 'routed');
  let T = code;
  const go = async (p) => {
    const res = await get(`/a/${T}${p}`);
    const loc = res.headers.get('location');
    const body = loc ? '' : await res.text();
    T = tokenFrom(loc || body, code) || T;
    return { res, body, loc };
  };

  // 2. The agent searches the site; the question is captured.
  await go('/plans/family');
  let x = await go(`/search?q=${encodeURIComponent('family plan 4 lines mexico travel keep our iphones')}`);
  assert.equal(x.res.status, 200);
  assert.ok(x.body.includes(`/a/${T}/travel/international-pass`), 'search results carry the token');

  // 3. A guessed URL is rescued inside the session.
  x = await go('/plans/international-roaming');
  assert.equal(x.res.status, 308);
  assert.equal(x.loc, `/a/${T}/travel/international-pass`);

  // 4. Context routing: the Mexico block leads. The decision used only the URL token, no lookup.
  x = await go('/travel/international-pass');
  assert.equal(x.res.headers.get('x-wake-rules'), 'mexico-first');
  assert.ok(x.body.indexOf('Mexico and Canada are included') < x.body.indexOf('$10 a day'), 'Mexico block moved above the daily price');

  // 5. Comparison and fact sheet.
  await go('/compare/crestline');
  x = await go('/agents.md');
  const md = x.body;
  assert.equal(x.res.headers.get('content-type').split(';')[0], 'text/markdown');
  assert.ok(md.includes(`](/a/${T}/compare/crestline)`));
  assert.ok(md.includes(`https://meridian.example/r/${T}/signup`), 'fact sheet hands out a tracked order link');
  assert.ok(md.indexOf('Mexico and Canada') < md.indexOf('Family plans'), 'Markdown block promoted');
  const A = `/a/${T}`;

  // 6. The agent checks its own link: not a handoff.
  let r2 = await get(`/r/${T}/signup`);
  assert.equal(r2.status, 307);
  r = r2;
  assert.equal(r.headers.get('location'), `${A}/signup`);

  // 7. A person opens the link on their phone.
  r = await get(`/r/${T}/signup?plan=unlimited-plus`, { ua: SAFARI, ip: '73.1.2.3' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signup?plan=unlimited-plus');
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  assert.equal(cookie, `wake_sid=${code}`);

  // 8. They see the normal site, then order.
  r = await get('/signup', { ua: SAFARI, ip: '73.1.2.3', headers: { cookie } });
  html = await r.text();
  assert.ok(!html.includes('/a/'), 'people get clean links');
  r = await get('/checkout/order', { ua: SAFARI, ip: '73.1.2.3', headers: { cookie }, method: 'POST', body: 'plan=unlimited-plus' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).order, '40-118-2275');

  // 9. The session tells the whole story.
  r = await get(`/_wake/api/sessions/${code}`, { ua: SAFARI, ip: '127.0.0.1' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.session.handoff_at && d.session.converted_at);
  assert.equal(d.session.conversion_value, 8352);
  const types = d.events.map((e) => e.type);
  for (const t of ['fetch', 'rescue', 'link_check', 'handoff', 'conversion']) assert.ok(types.includes(t), `has ${t}`);
  const ids = d.session.intents.filter((i) => i.score >= 2).map((i) => i.id);
  for (const id of ['family', 'travel', 'switch', 'byop']) assert.ok(ids.includes(id), `intent ${id} in ${ids}`);
  assert.ok(d.brief.text.includes('Mexico and Canada are included on Unlimited Plus.'), d.brief.text);
  assert.ok(d.brief.questions[0].startsWith('family plan 4 lines'));
  assert.deepEqual(d.exposures.find((x) => x.rule === 'mexico-first').arm, 'routed');
});

test('holdout sessions see the page unchanged', async () => {
  const code = codeFor('mexico-first', 'holdout');
  const { responses } = await walk(get, code, ['/plans/family', '/search?q=mexico+travel', '/travel/international-pass']);
  const { r, body: html } = responses[2];
  assert.equal(r.headers.get('x-wake-rules'), 'mexico-first (holdout)');
  assert.ok(html.indexOf('$10 a day') < html.indexOf('Mexico and Canada are included'), 'original order kept');
});

test('search engines and crawlers never keep session URLs', async () => {
  let r = await get('/a/MW-ZZZZ99/plans/family', { ua: GOOGLEBOT });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/plans/family');
  r = await get('/plans/family', { ua: GPTBOT });
  const html = await r.text();
  assert.equal(r.headers.get('x-wake-session'), null);
  assert.ok(!html.includes('/a/'), 'training crawler gets clean links');
});

test('shadow mode changes nothing and still groups reads into sessions', async () => {
  const store = openStore(':memory:');
  const upstream = `http://127.0.0.1:${site.address().port}`;
  const shadow = createWake({ ...structuredClone(baseConfig), upstream, mode: 'shadow' }, { store });
  const read = (p, ip) => shadow.handle(new Request('http://proxy.test' + p, { headers: { 'user-agent': CHATGPT } }), { ip });
  for (const p of ['/plans/family', '/search?q=family+mexico+travel', '/travel/international-pass']) {
    const viaWake = await (await read(p, '20.9.9.9')).text();
    const direct = await (await fetch(upstream + p)).text();
    assert.equal(viaWake, direct, `${p} is byte-identical`);
  }
  await read('/', '20.9.9.10');
  const sessions = store.db.prepare('SELECT code, origin FROM sessions ORDER BY created_at').all();
  assert.equal(sessions.length, 2, 'same network and agent = one session; another network = another');
  assert.ok(sessions.every((x) => x.origin === 'shadow' && x.code.startsWith('SH-')));
  const travel = store.events(sessions[0].code).find((e) => e.path === '/travel/international-pass');
  assert.deepEqual(travel.data.wouldApply, ['mexico-first'], 'reports the rule it would have applied');
});

test('a person opening a forwarded session URL gets the clean page and joins the session', async () => {
  const code = (await get('/plans/loyalty', { ip: '20.5.5.5' })).headers.get('x-wake-session');
  const r = await get(`/a/${code}/plans/loyalty`, { ua: SAFARI, ip: '73.9.9.9', headers: { referer: 'https://chatgpt.com/' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/plans/loyalty');
  assert.ok(r.headers.getSetCookie()[0].startsWith(`wake_sid=${code}`));
});

test('unknown pages with no close match stay 404 and are logged', async () => {
  const r = await get('/a/MW-LOST01/careers/engineering');
  assert.equal(r.status, 404);
  const o = await (await get('/_wake/api/overview', { ip: '127.0.0.1' })).json();
  const g = o.guessed.find((x) => x.path === '/careers/engineering');
  assert.ok(g && !g.rescuedTo);
});

test('dashboard is locked to localhost without a token', async () => {
  assert.equal((await get('/_wake/', { ip: '8.8.8.8', ua: SAFARI })).status, 403);
  const r = await get('/_wake/', { ip: '127.0.0.1', ua: SAFARI });
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes('<title>Wake</title>'));
  const o = await (await get('/_wake/api/overview', { ip: '127.0.0.1' })).json();
  assert.ok(o.kpis.sessions >= 4);
  assert.equal(o.kpis.conversions, 1);
  assert.equal(o.kpis.value, 8352);
  assert.equal(o.attribution[0].label, 'Direct');
  assert.ok(o.questions.some((q) => q.query.includes('mexico')));
  assert.ok(o.guessed.some((g) => g.path === '/plans/international-roaming' && g.rescuedTo === '/travel/international-pass'));
});

test('server-side conversion hook', async () => {
  const code = (await get('/deals/bring-your-own-phone', { ip: '20.7.7.7' })).headers.get('x-wake-session');
  const r = await fetch(`${W}/_wake/api/convert`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' }, body: JSON.stringify({ code, name: 'store-activation', value: 120 }) });
  assert.equal(r.status, 200);
  const d = await (await get(`/_wake/api/sessions/${code}`, { ip: '127.0.0.1' })).json();
  assert.equal(d.session.conversion_value, 120);
});

test('an unreachable site returns 502 and leaves no empty session behind', async () => {
  const store = openStore(':memory:');
  const down = createWake({ upstream: 'http://127.0.0.1:9' }, { store });
  const r = await down.handle(new Request('http://proxy.test/plans', { headers: { 'user-agent': CHATGPT } }), { ip: '20.1.1.1' });
  assert.equal(r.status, 502);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
});

test('the brief names pages without the site suffix and skips search pages', async () => {
  const code = codeFor('mexico-first', 'routed');
  const d = await (await get(`/_wake/api/sessions/${code}`, { ip: '127.0.0.1' })).json();
  const titles = d.brief.pages.map((p) => p.title);
  assert.ok(titles.includes('Family plans') && titles.includes('International Pass'), titles.join(', '));
  assert.ok(!titles.some((t) => t.includes('|') || t === 'Search'));
});
