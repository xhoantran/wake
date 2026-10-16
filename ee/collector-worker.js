// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
//
// The Wake collector as a Cloudflare Worker, with Postgres (for example Supabase) reached through Hyperdrive.
//   // worker.js
//   export { default } from 'wake/ee/collector-worker';
// Bindings and secrets (see deploy/cloudflare/wrangler.toml):
//   HYPERDRIVE          Hyperdrive binding to the Postgres database (or DATABASE_URL for a direct connection)
//   WAKE_SECRET         signs dashboard links
//   ANTHROPIC_API_KEY   optional; enables the scheduled answer checks
// Apply the schema once from your machine before the first deploy: `wake admin` against the same database runs
// the migrations. The Worker never migrates, so a cold start doesn't take a lock on the database.
//
// Hyperdrive pools connections near the database, so each request opens one cheap client and closes it after the
// response. AsyncLocalStorage keeps requests that share an isolate on their own clients.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHostedCollector } from './collector.js';
import { openPostgres, pgTypes } from './storage/postgres.js';
import { wrapStorage } from '../src/storage/wrap.js';
import { normalizeConfig } from '../src/config.js';
import { runChecks, claudeEngine, claudeJudge } from '../src/checks.js';

export function createCollectorWorker(options = {}) {
  const scopes = new AsyncLocalStorage();
  let setup = null;
  let pgModule = options.pg || null;
  let connectionString = null;

  // A pg-compatible "pool" whose queries run on the current request's client, opened on first use.
  const pool = {
    async query(text, params) {
      const scope = scopes.getStore();
      if (!scope) throw new Error('wake: database used outside a request');
      if (!scope.client) {
        scope.client = (async () => {
          const c = new pgModule.Client({ connectionString, types: pgTypes(pgModule) });
          await c.connect();
          return c;
        })();
      }
      return (await scope.client).query(text, params);
    },
  };

  function init(env) {
    if (!setup) {
      setup = (async () => {
        connectionString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
        if (!connectionString) throw new Error('wake: bind HYPERDRIVE (or set DATABASE_URL) to the collector Worker');
        if (!pgModule) pgModule = (await import('pg')).default;
        const storage = wrapStorage(await openPostgres(pool, { migrate: false }));
        const collector = createHostedCollector({ storage, secret: env.WAKE_SECRET || null, limits: options.limits, log: (m) => console.log(m) });
        return { storage, collector };
      })();
      setup.catch(() => { setup = null; }); // retry on the next request
    }
    return setup;
  }

  /** Run fn with its own database client, closed when fn settles (after the response, via waitUntil). */
  async function withDb(ctx, fn) {
    const scope = { client: null };
    try {
      return await scopes.run(scope, fn);
    } finally {
      if (scope.client) {
        const closing = scope.client.then((c) => c.end()).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(closing);
        else await closing;
      }
    }
  }

  /** Answer checks for every site whose config lists facts. Each site runs on its own client. */
  async function checkAllSites(env, ctx) {
    const apiKey = env.ANTHROPIC_API_KEY;
    const engines = options.checks?.engines || (apiKey ? [claudeEngine({ apiKey })] : null);
    const judge = options.checks?.judge || (apiKey ? claudeJudge({ apiKey }) : null);
    if (!engines || !judge) {
      console.log('wake: ANTHROPIC_API_KEY is not set; skipping answer checks');
      return [];
    }
    const { storage, collector } = await init(env);
    const sites = await withDb(ctx, () => storage.tenants.listSites());
    const results = [];
    for (const site of sites) {
      const result = await withDb(ctx, async () => {
        const entry = await collector.tenants.getConfig(site.id, { fresh: true });
        const config = entry ? normalizeConfig(entry.raw) : null;
        if (!config?.answerChecks.facts.length) return { site: site.id, skipped: 'no facts' };
        try {
          const summary = await runChecks({ config, store: storage.site(site.id), engines, judge, log: (m) => console.log(`${site.id}: ${m}`) });
          return { site: site.id, ...summary };
        } catch (err) {
          return { site: site.id, error: err.message };
        }
      });
      results.push(result);
    }
    return results;
  }

  return {
    async fetch(request, env, ctx) {
      let ready;
      try {
        ready = await init(env);
      } catch (err) {
        console.error(err);
        return Response.json({ error: 'The collector is not configured: ' + err.message }, { status: 500 });
      }
      const ip = request.headers.get('cf-connecting-ip') || '';
      try {
        return await withDb(ctx, () => ready.collector.handle(request, { ip }));
      } catch (err) {
        console.error(err);
        return Response.json({ error: 'The collector could not complete the request.' }, { status: 503 });
      }
    },
    async scheduled(_controller, env, ctx) {
      const results = await checkAllSites(env, ctx);
      for (const r of results) console.log('wake answer checks', JSON.stringify(r));
      return results;
    },
  };
}

export default createCollectorWorker();
