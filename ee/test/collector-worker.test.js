// Wake Enterprise (ee/LICENSE).
// The collector as a Cloudflare Worker (ee/collector-worker.js).
// The import-graph test always runs. The rest needs Postgres: set WAKE_TEST_PG=postgres://user@host:port/db
// (each run creates and drops its own database). Hyperdrive is stood in for by a plain connection string,
// which is what the binding hands the Worker.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import baseConfig from '../../examples/meridian/wake.config.js';
import { createSite } from '../../examples/meridian/site-server.js';
import { createWorker } from '../../adapters/worker.js';
import { createTelemetry } from '../../src/sdk/telemetry.js';
import { tokenFrom } from '../../test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const SECRET = 'worker-test-secret';

/** Every module reachable from a file through relative imports (static and dynamic with a literal path). */
function importGraph(entry) {
  const seen = new Set();
  const external = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  walk(path.join(ROOT, entry));
  return { files: [...seen].map((f) => path.relative(ROOT, f)), external: [...external] };
}

test('Worker bundles never load node:sqlite or the Node http server', () => {
  for (const entry of ['ee/collector-worker.js', 'adapters/worker.js', 'ee/deploy/cloudflare/worker.js']) {
    const g = importGraph(entry);
    assert.ok(!g.external.includes('node:sqlite'), `${entry} reaches node:sqlite via ${g.files.join(', ')}`);
    assert.ok(!g.files.some((f) => f === 'src/storage/sqlite.js' || f === 'src/store.js' || f === 'src/node.js'), `${entry} reaches ${g.files.join(', ')}`);
  }
});

describe('collector Worker on Postgres', { skip: !process.env.WAKE_TEST_PG && 'set WAKE_TEST_PG to run' }, () => {
  let pg, admin, dbName, url, site, S, key, siteId, token, worker, env;
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const call = (p, { key: k, method = 'GET', body, cookie } = {}) => worker.fetch(new Request('https://collector.test' + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'cf-connecting-ip': '203.0.113.7' },
  }), env, ctx);
  const read = (code, p, extra = {}) => ({ v: 1, ts: Date.now(), code, type: 'fetch', actor: 'agent', agent: 'ChatGPT', vendor: 'OpenAI', kind: 'live',
    ipHash: 'ab12cd34', ua: CHATGPT, method: 'GET', path: p, status: 200, data: { minted: true }, ...extra });

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: process.env.WAKE_TEST_PG });
    await admin.connect();
    dbName = `wake_worker_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(process.env.WAKE_TEST_PG);
    u.pathname = '/' + dbName;
    url = u.toString();

    // What `wake admin` does before the first deploy: migrate, then create an organization, a site and a key.
    const { openHostedStorage: openStorage } = await import('../storage.js');
    const { createTenants } = await import('../tenants.js');
    const storage = await openStorage(url);
    const tenants = createTenants(storage, { secret: SECRET });
    await tenants.createOrg({ id: 'meridian', name: 'Meridian' });
    const config = { ...structuredClone(baseConfig), mode: 'trace', answerChecks: { ...baseConfig.answerChecks, questions: ['Does Unlimited Plus include Mexico?'] } };
    const created = await tenants.createSite({ orgId: 'meridian', id: 'meridian-web', name: 'Meridian', config });
    siteId = created.id;
    key = (await tenants.issueKey(siteId)).key;
    token = tenants.signToken({ site: siteId });
    await storage.close();

    site = createSite();
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    S = `http://127.0.0.1:${site.address().port}`;

    const { createCollectorWorker } = await import('../collector-worker.js');
    const fakeEngine = { id: 'fake-assistant', model: 'fake-1', async ask() { return { text: 'Mexico costs $10 a day.' }; } };
    const fakeJudge = { async judge({ facts }) { return facts.map((f) => ({ factId: f.id, verdict: f.id === 'mexico-included' ? 'wrong' : 'missing', quote: 'Mexico costs $10 a day.' })); } };
    worker = createCollectorWorker({ pg, checks: { engines: [fakeEngine], judge: fakeJudge } });
    env = { HYPERDRIVE: { connectionString: url }, WAKE_SECRET: SECRET };
  });

  after(async () => {
    await settle();
    site?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  test('without a database binding it answers with a clear error', async () => {
    const { createCollectorWorker } = await import('../collector-worker.js');
    const bare = createCollectorWorker({ pg });
    const r = await bare.fetch(new Request('https://collector.test/healthz'), {}, ctx);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /HYPERDRIVE/);
  });

  test('serves the SDK config and accepts events for the key\'s site', async () => {
    assert.equal((await call('/healthz')).status, 200);
    const cfg = await (await call('/v1/config', { key })).json();
    assert.equal(cfg.mode, 'trace');
    assert.equal(cfg.version, 1);
    assert.equal((await call('/v1/config', { key: 'wk_wrong' })).status, 401);

    const r = await call('/v1/events', { key, method: 'POST', body: { events: [read('MW-WORKR1', '/plans/family'), read('MW-WORKR1', '/travel/international-pass')] } });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 2, ignored: 0, rejected: 0 });
  });

  test('concurrent requests in one isolate each get their own client, and every client is closed', async () => {
    const batches = Array.from({ length: 12 }, (_, i) => call('/v1/events', { key, method: 'POST', body: { events: [read(`MW-PAR${String(i).padStart(3, '0')}`, '/compare/crestline')] } }));
    const results = await Promise.all(batches);
    assert.ok(results.every((r) => r.status === 202));
    await settle();
    const open = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [dbName]);
    assert.equal(open.rows[0].n, 0, 'no connection left open after the responses');
  });

  test('the dashboard reads the site through a signed link', async () => {
    const r = await call(`/_wake/sites/${siteId}/api/sessions`, { cookie: `wake_dash=${token}` });
    assert.equal(r.status, 200);
    const codes = (await r.json()).map((s) => s.code);
    assert.ok(codes.includes('MW-WORKR1') && codes.includes('MW-PAR011'), codes.join(', '));
    assert.equal((await call(`/_wake/sites/${siteId}/api/sessions`)).status, 401);
  });

  test('an SDK Worker sends a real agent journey to the collector Worker', async () => {
    const collectorFetch = (u, init) => worker.fetch(new Request(u, init), env, ctx);
    const telemetry = createTelemetry({ endpoint: 'https://collector.test', apiKey: key, flushMs: 0, fetch: collectorFetch });
    const toSite = (req) => fetch(S + new URL(req.url).pathname + new URL(req.url).search, { method: req.method, headers: req.headers, redirect: 'manual' });
    const sdk = createWorker({ config: { ...structuredClone(baseConfig), mode: 'trace' }, telemetry, fetch: toSite });
    const req = (p) => new Request('https://www.meridian.example' + p, { headers: { 'user-agent': CHATGPT, 'cf-connecting-ip': '20.1.2.3' } });

    let r = await sdk.fetch(req('/plans/family'), {}, ctx);
    const code = r.headers.get('x-wake-session');
    const t = tokenFrom(await r.text(), code);
    r = await sdk.fetch(req(`/a/${t}/compare/crestline`), {}, ctx);
    await r.text();
    await settle();
    assert.equal(telemetry.stats.dropped, 0);

    const d = await (await call(`/_wake/sites/${siteId}/api/sessions/${code}`, { cookie: `wake_dash=${token}` })).json();
    assert.deepEqual(d.events.map((e) => e.path), ['/plans/family', '/compare/crestline']);
  });

  test('the cron trigger runs answer checks for sites with facts', async () => {
    const results = await worker.scheduled({ cron: '0 6 * * *' }, env, ctx);
    await settle();
    const mine = results.find((x) => x.site === siteId);
    assert.equal(mine.answers, 1);
    assert.equal(mine.wrong, 1);
    const answers = await (await call(`/_wake/sites/${siteId}/api/answers`, { cookie: `wake_dash=${token}` })).json();
    assert.equal(answers[0].engine, 'fake-assistant');
  });
});
