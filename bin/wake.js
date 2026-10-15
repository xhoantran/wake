#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createWake } from '../src/wake.js';
import { openStore, openStorage } from '../src/store.js';
import { runAdmin, ADMIN_USAGE } from '../src/admin.js';
import { createTenants } from '../src/tenants.js';
import { serve } from '../src/node.js';
import { normalizeConfig } from '../src/config.js';
import { runChecks } from '../src/checks.js';
import { createCollector } from '../src/collector.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c' },
    upstream: { type: 'string', short: 'u' },
    port: { type: 'string', short: 'p', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    db: { type: 'string', default: process.env.WAKE_DB || 'wake.db' }, // SQLite file, or postgres://… for the hosted collector
    secret: { type: 'string' }, // collector / admin: signs dashboard links (or WAKE_SECRET)
    site: { type: 'string' }, org: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' }, key: { type: 'string' },
    'grace-hours': { type: 'string' }, days: { type: 'string' }, url: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    'trust-proxy': { type: 'boolean', default: false },
    engines: { type: 'string' }, // check: module exporting { engines, judge } that replace the config's
    endpoint: { type: 'string' }, // proxy: remote collector URL
    'api-key': { type: 'string' }, // proxy: key for the remote collector; collector: accepted key(s), comma-separated
  },
});

const load = async (file) => import(pathToFileURL(path.resolve(file)).href);
let config = {};
if (values.config) config = (await load(values.config)).default;
if (values.upstream) config = { ...config, upstream: values.upstream };
const command = positionals[0] || 'proxy';
if (!values.config && command === 'check' && !values.site) { usage(); process.exit(1); }
if (command === 'proxy' && !config.upstream) { usage(); process.exit(1); }

function usage() {
  console.error('Usage:');
  console.error('  wake [proxy] --upstream https://www.example.com [--config wake.config.js] [--port 8787] [--db wake.db]');
  console.error('       Proxy with a built-in collector and dashboard (local trials, demos).');
  console.error('  wake proxy --config wake.config.js --endpoint https://collector --api-key KEY');
  console.error('       Proxy that reports to a remote collector.');
  console.error('  wake collector --config wake.config.js --api-key KEY[,KEY2] [--port 8790] [--db wake.db]');
  console.error('       Single-site collector: event ingest, SDK config and the dashboard.');
  console.error('  wake collector --db postgres://… --secret SECRET [--port 8790]');
  console.error('       Hosted, multi-site collector. Sites, keys and configs come from the database (see wake admin).');
  console.error('  wake check (--config wake.config.js | --site SITE) [--db wake.db] [--engines engines.js]');
  console.error('  ' + ADMIN_USAGE.replace(/\n/g, '\n  '));
}

const secret = values.secret || process.env.WAKE_SECRET || null;

if (command === 'admin') {
  try {
    await runAdmin(positionals.slice(1), values, { loadConfig: async (file) => (await load(file)).default });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'check') {
  const override = values.engines ? await load(values.engines) : {};
  try {
    let store = null;
    if (values.site) {
      // One site of a multi-site storage; its saved config unless --config is given.
      const storage = await openStorage(values.db);
      store = storage.site(values.site);
      if (!values.config) {
        const entry = await createTenants(storage).getConfig(values.site);
        if (!entry) throw new Error(`No config saved for site "${values.site}"`);
        config = entry.raw;
      }
    }
    const s = await runChecks({
      config: normalizeConfig(config), store: store || openStore(values.db),
      engines: override.engines, judge: override.judge, log: (line) => console.log('  ' + line),
    });
    console.log(`Asked ${s.questions} questions of ${s.engines.join(', ')}: ${s.answers} answers, ${s.wrong} wrong claims, ${s.correct} correct, ${s.errors} errors.`);
    console.log(`See "What agents say vs the truth" on the dashboard.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (command === 'collector') {
  const apiKeys = String(values['api-key'] || '').split(',').map((k) => k.trim()).filter(Boolean);
  const single = Boolean(values.config);
  if (single && /^postgres/i.test(values.db)) { console.error('A single-site collector uses SQLite. For Postgres, drop --config and manage sites with wake admin.'); process.exit(1); }
  const collector = single
    ? createCollector({ config, store: openStore(values.db), apiKeys, secret, log: console.warn })
    : createCollector({ storage: await openStorage(values.db), secret, log: console.warn });
  await collector.ready;
  const port = values.port === '8787' ? 8790 : Number(values.port);
  await serve(collector, { port, host: values.host, trustProxy: values['trust-proxy'] });
  const origin = `http://${values.host}:${port}`;
  console.log(`Wake collector on ${origin} (${single ? 'single site' : 'multi-site'}, ${/^postgres/i.test(values.db) ? 'Postgres' : 'SQLite ' + values.db})`);
  if (single) console.log(`  Events:    POST ${origin}/v1/events   (${apiKeys.length ? apiKeys.length + ' API key(s)' : 'localhost only, no API key set'})`);
  else console.log(`  Events:    POST ${origin}/v1/events   (API keys from wake admin)`);
  console.log(`  SDK config: GET ${origin}/v1/config`);
  console.log(`  Dashboard: ${origin}${collector.dashboardPath}/${single ? '' : 'sites/<site>/'}${secret ? '   (open with a link from wake admin token)' : '   (localhost only: no --secret set)'}`);
} else if (command === 'proxy') {
  const remote = values.endpoint ? { endpoint: values.endpoint, apiKey: values['api-key'] } : { store: openStore(values.db) };
  const wake = createWake(config, remote);
  await serve(wake, { port: Number(values.port), host: values.host, trustProxy: values['trust-proxy'] });
  const origin = `http://${values.host}:${values.port}`;
  console.log(`Wake is in front of ${config.upstream}`);
  console.log(`  Site:      ${origin}/`);
  if (values.endpoint) console.log(`  Events go to ${values.endpoint}`);
  else console.log(`  Dashboard: ${origin}${wake.config.dashboard.path}/${wake.config.dashboard.token ? '?token=…' : ''}`);
} else {
  console.error(`Unknown command "${command}". Commands: proxy, collector, check, admin`);
  process.exit(1);
}
