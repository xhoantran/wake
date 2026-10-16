// Wake Enterprise (ee/LICENSE).
// The hosted, multi-site collector: tenants, isolation, keys, versioned configs, dashboard links and ingest limits.
// Runs on SQLite; set WAKE_TEST_PG=postgres://user@host:port/db to run the same tests on Postgres as well
// (each run creates and drops its own database).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import baseConfig from '../../examples/meridian/wake.config.js';
import { openHostedStorage as openStorage } from '../storage.js';
import { createHostedCollector as createCollector } from '../collector.js';
import { createConfigSource } from '../../src/sdk/config-source.js';
import { overview } from '../../src/reports.js';

const DAY = 86_400_000;
const SECRET = 'test-secret-1';

function read(code, p, ts, extra = {}) {
  return { v: 1, ts, code, type: 'fetch', actor: 'agent', agent: 'ChatGPT-User', vendor: 'OpenAI', kind: 'live',
    ipHash: 'ab12cd34', ua: 'ChatGPT-User/1.0', method: 'GET', path: p, status: 200, data: { minted: true }, ...extra };
}

const backends = [{ name: 'SQLite', open: async () => ({ storage: openStorage(':memory:'), drop: async () => {} }) }];
if (process.env.WAKE_TEST_PG) {
  backends.push({
    name: 'Postgres',
    async open() {
      const { default: pg } = await import('pg');
      const admin = new pg.Client({ connectionString: process.env.WAKE_TEST_PG });
      await admin.connect();
      const db = `wake_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
      await admin.query(`CREATE DATABASE ${db}`);
      const url = new URL(process.env.WAKE_TEST_PG);
      url.pathname = '/' + db;
      const storage = await openStorage(url.toString());
      return {
        storage,
        drop: async () => { await storage.close(); await admin.query(`DROP DATABASE ${db}`); await admin.end(); },
      };
    },
  });
}

for (const backend of backends) {
  describe(`hosted collector on ${backend.name}`, () => {
    let storage, drop, collector, clock, A, B, orgB;
    const call = (p, { key, token, ip = '203.0.113.9', method = 'GET', body, headers = {} } = {}) => collector.handle(new Request('http://collector.test' + p, {
      method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(token ? { cookie: `wake_dash=${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }), { ip });
    const send = (key, events) => call('/v1/events', { key, method: 'POST', body: { events } });

    before(async () => {
      ({ storage, drop } = await backend.open());
      clock = { t: Date.UTC(2026, 9, 15, 12) };
      collector = createCollector({ storage, secret: SECRET, now: () => clock.t, limits: { eventsPerMinute: 50 } });
      const t = collector.tenants;
      const orgA = await t.createOrg({ id: 'acme', name: 'Acme' });
      orgB = await t.createOrg({ id: 'bolt', name: 'Bolt' });
      const cfg = (name, codePrefix) => ({ ...structuredClone(baseConfig), name, codePrefix, mode: 'trace' });
      A = await t.createSite({ orgId: orgA.id, id: 'acme-shop', name: 'Acme shop', config: cfg('Acme shop', 'AC') });
      B = await t.createSite({ orgId: orgB.id, id: 'bolt-store', name: 'Bolt store', config: { ...cfg('Bolt store', 'BO'), rules: [], brief: { enabled: false } } });
      A.key = (await t.issueKey(A.id)).key;
      B.key = (await t.issueKey(B.id)).key;
      A.token = t.signToken({ site: A.id });
      B.token = t.signToken({ site: B.id });
    });
    after(() => drop());

    test('two sites never see each other\'s sessions or configs', async () => {
      const t0 = clock.t;
      let r = await send(A.key, [read('AC-SHARED', '/plans/family', t0), read('AC-ONLY01', '/travel/international-pass', t0 + 1)]);
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { accepted: 2, ignored: 0, rejected: 0 });
      // The same code under the other site is a different session.
      r = await send(B.key, [read('AC-SHARED', '/compare/crestline', t0 + 2)]);
      assert.equal((await r.json()).accepted, 1);

      const sessions = async (site, token) => (await (await call(`/_wake/sites/${site.id}/api/sessions`, { token })).json());
      assert.deepEqual((await sessions(A, A.token)).map((s) => s.code).sort(), ['AC-ONLY01', 'AC-SHARED']);
      assert.deepEqual((await sessions(B, B.token)).map((s) => s.code), ['AC-SHARED']);

      const detail = await (await call(`/_wake/sites/${B.id}/api/sessions/AC-SHARED`, { token: B.token })).json();
      assert.deepEqual(detail.events.map((e) => e.path), ['/compare/crestline'], 'B sees only its own events for the shared code');
      assert.equal((await call(`/_wake/sites/${B.id}/api/sessions/AC-ONLY01`, { token: B.token })).status, 404);

      const o = await (await call(`/_wake/sites/${B.id}/api/overview`, { token: B.token })).json();
      assert.equal(o.kpis.sessions, 1);
      assert.equal(o.site, 'Bolt store');
      assert.equal(o.experiments.length, 0, 'B has no rules; A\'s rules are not mixed in');

      // A site's token opens only that site, and an API key only reads its own site's config.
      assert.equal((await call(`/_wake/sites/${A.id}/api/sessions`, { token: B.token })).status, 401);
      assert.equal((await call(`/_wake/sites/${A.id}/api/config`, { token: B.token })).status, 401);
      const cfgA = await (await call('/v1/config', { key: A.key })).json();
      const cfgB = await (await call('/v1/config', { key: B.key })).json();
      assert.equal(cfgA.codePrefix, 'AC');
      assert.equal(cfgB.codePrefix, 'BO');
      assert.equal(cfgA.rules.length, 3);
      assert.equal(cfgB.rules.length, 0);
      assert.ok(!JSON.stringify(cfgA).includes('answerChecks') && cfgA.upstream === undefined, 'no secrets or deployment settings');

      // The store itself: every query is scoped.
      assert.equal((await overview(storage.site(A.id), (await collector.siteConfig(A.id)).config)).kpis.sessions, 2);
      assert.equal(await storage.site('nobody').getSession('AC-SHARED'), undefined);
    });

    test('dashboard links: signed per site or per organization, expiring, and no localhost bypass when hosted', async () => {
      assert.equal((await call(`/_wake/sites/${A.id}/`, { ip: '127.0.0.1' })).status, 401, 'a hosted collector has no localhost rule');
      let r = await call(`/_wake/sites/${A.id}/?token=${A.token}`);
      assert.equal(r.status, 302);
      assert.match(r.headers.get('set-cookie'), new RegExp(`^wake_dash=wkd\\.[^;]+; Path=/_wake/sites/${A.id}; HttpOnly; SameSite=Strict`));
      assert.equal((await call(`/_wake/sites/${A.id}/`, { token: A.token })).status, 200);

      const orgToken = collector.tenants.signToken({ org: orgB.id });
      assert.equal((await call(`/_wake/sites/${B.id}/api/overview`, { token: orgToken })).status, 200);
      assert.equal((await call(`/_wake/sites/${A.id}/api/overview`, { token: orgToken })).status, 401, 'another organization\'s site');
      const index = await (await call('/_wake/', { token: orgToken })).text();
      assert.ok(index.includes(`/_wake/sites/${B.id}/`) && !index.includes(A.id), 'the index lists only the organization\'s sites');

      const forged = A.token.replace(/\.[^.]+$/, '.AAAA');
      assert.equal((await call(`/_wake/sites/${A.id}/`, { token: forged })).status, 401);
      const other = createCollector({ storage, secret: 'another-secret', now: () => clock.t });
      assert.equal((await other.handle(new Request(`http://c/_wake/sites/${A.id}/`, { headers: { cookie: `wake_dash=${A.token}` } }), { ip: '1.1.1.1' })).status, 401);
      const short = collector.tenants.signToken({ site: A.id, ttlMs: 1000 });
      clock.t += 2000;
      assert.equal((await call(`/_wake/sites/${A.id}/`, { token: short })).status, 401, 'expired');
    });

    test('key rotation: the new key works at once, old keys until the grace period ends, revoked keys never', async () => {
      const t = collector.tenants;
      const key1 = (await t.issueKey(A.id)).key;
      assert.equal((await send(key1, [])).status, 202);
      const rotated = await t.rotateKey(A.id, { graceMs: 60_000 });
      assert.equal((await send(rotated.key, [])).status, 202);
      assert.equal((await send(key1, [])).status, 202, 'old key inside the grace period');
      clock.t += 61_000;
      assert.equal((await send(key1, [])).status, 401, 'old key after the grace period');
      assert.equal((await send(A.key, [])).status, 401, 'every other key of the site rotated out too');
      assert.equal((await send(B.key, [])).status, 202, 'other sites are untouched');
      await t.revokeKey(rotated.id);
      assert.equal((await send(rotated.key, [])).status, 401);

      const keys = await t.listKeys(A.id);
      assert.ok(keys.every((k) => !JSON.stringify(k).includes(rotated.key)), 'keys are stored as hashes');
      A.key = (await t.issueKey(A.id)).key;
    });

    test('a config saved in the dashboard reaches the SDK through createConfigSource', async () => {
      const seen = [];
      const viaCollector = async (url, init) => {
        const r = await collector.handle(new Request(url, init), { ip: '198.51.100.7' });
        seen.push(r.status);
        return r;
      };
      const source = createConfigSource({ endpoint: 'http://collector.test', apiKey: A.key, refreshMs: 0, fetch: viaCollector });
      const v1 = await source.refresh();
      assert.equal(v1.mode, 'trace');
      const before = v1.version;

      const current = await (await call(`/_wake/sites/${A.id}/api/config`, { token: A.token })).json();
      assert.equal(current.version, before);
      const rules = current.rules.map((r) => (r.id === 'mexico-first' ? { ...r, holdout: 0.5 } : r));
      let r = await call(`/_wake/sites/${A.id}/api/config`, { token: A.token, method: 'POST', body: { baseVersion: current.version, mode: 'route', rules } });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).version, before + 1);

      const v2 = await source.refresh();
      assert.equal(v2.version, before + 1);
      assert.equal(v2.mode, 'route');
      assert.equal(v2.rules.find((x) => x.id === 'mexico-first').holdout, 0.5);
      assert.equal(v2.intents.length, 5, 'fields the dashboard did not send are kept');
      await source.refresh();
      assert.equal(seen.at(-1), 304, 'an unchanged version is not sent again');
      assert.equal(source.get().version, before + 1);

      // Validated with normalizeConfig before saving; stale edits are refused.
      r = await call(`/_wake/sites/${A.id}/api/config`, { token: A.token, method: 'POST', body: { baseVersion: before + 1, rules: [{ id: 'x', promote: 'mexico-included', holdout: 1.5 }] } });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /holdout share between 0 and 1/);
      r = await call(`/_wake/sites/${A.id}/api/config`, { token: A.token, method: 'POST', body: { baseVersion: before + 1, mode: 'chaos' } });
      assert.equal(r.status, 400);
      r = await call(`/_wake/sites/${A.id}/api/config`, { token: A.token, method: 'POST', body: { baseVersion: before, mode: 'shadow' } });
      assert.equal(r.status, 409);
      r = await call(`/_wake/sites/${A.id}/api/config`, { token: A.token, method: 'POST', body: '{"mode":"shadow"}', headers: { 'content-type': 'text/plain' } });
      assert.equal(r.status, 415, 'no form posts');
      assert.equal((await collector.siteConfig(A.id)).version, before + 1);
      const history = (await (await call(`/_wake/sites/${A.id}/api/config`, { token: A.token })).json()).history;
      assert.deepEqual(history.slice(0, 2).map((h) => [h.version, h.source]), [[before + 1, 'dashboard'], [before, 'created']]);
    });

    test('ingest limits: per-key rate, payload size, and event age', async () => {
      const t0 = clock.t += 120_000; // a full bucket
      const batch = (n, from = 0) => Array.from({ length: n }, (_, i) => read(`AC-RATE${String(from + i).padStart(2, '0')}`, '/plans/family', t0));
      assert.equal((await send(A.key, batch(40))).status, 202);
      const r = await send(A.key, batch(20, 40));
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.equal((await send(B.key, batch(20))).status, 202, 'limits are per key');
      clock.t += 30_000; // 25 events refilled
      assert.equal((await send(A.key, batch(20, 40))).status, 202);

      clock.t += 120_000;
      const big = JSON.stringify({ events: [read('AC-BIG001', '/', clock.t, { title: 'x'.repeat(1_100_000) })] });
      assert.equal((await call('/v1/events', { key: A.key, method: 'POST', body: big })).status, 413);
      const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
      const res = await collector.handle(new Request('http://collector.test/v1/events', { method: 'POST', body: chunked, duplex: 'half', headers: { authorization: `Bearer ${A.key}` } }), { ip: '1.1.1.1' });
      assert.equal(res.status, 413, 'also without a Content-Length');

      const now = clock.t;
      const counts = await (await send(A.key, [
        read('AC-OLD001', '/', now - 8 * DAY), read('AC-NEW001', '/', now - 6 * DAY),
        read('AC-FUT001', '/', now + 60 * 60_000), read('AC-SKEW01', '/', now + 60_000),
      ])).json();
      assert.deepEqual(counts, { accepted: 2, ignored: 0, rejected: 2 });
      assert.equal(await storage.site(A.id).getSession('AC-OLD001'), undefined);
      assert.ok(await storage.site(A.id).getSession('AC-SKEW01'), 'a minute of clock skew is allowed');
    });
  });
}
