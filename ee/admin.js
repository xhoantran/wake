// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
//
// `wake admin …`: organizations, sites, API keys, site configs and dashboard links, straight against the storage.
import { createTenants } from './tenants.js';
import { openHostedStorage as openStorage } from './storage.js';
import { TABLES } from '../src/storage/sql.js';

const HOUR = 3_600_000;

export const ADMIN_USAGE = `wake admin <command> [--db wake.db | postgres://…]
  org create --name "Acme" [--id acme]
  site create --org ORG --name "Acme shop" [--id ID] [--config wake.config.js]   (prints the site's first API key)
  sites [--org ORG]
  key create --site SITE              a new API key (shown once)
  key import --site SITE --key KEY    register a key SDKs already use (moving from a single-site collector)
  key rotate --site SITE [--grace-hours 24]   new key; the site's other keys stop working after the grace period
  key revoke --id KEY_ID
  keys --site SITE
  config import --site SITE --config wake.config.js
  config show --site SITE
  token (--site SITE | --org ORG) [--days 30] [--url http://collector]   signed dashboard link (needs --secret or WAKE_SECRET)
  copy --from wake.db --to postgres://…   copy every site's data from SQLite into Postgres`;

const fmt = (t) => (t ? new Date(Number(t)).toISOString().replace('T', ' ').slice(0, 16) : '');

export async function runAdmin(args, values, { loadConfig, log = console.log } = {}) {
  const [cmd, sub] = args;
  if (cmd === 'copy') return copy(values, log);
  const need = (k) => {
    if (!values[k]) throw new Error(`wake admin ${args.join(' ')}: --${k} is required`);
    return values[k];
  };
  const storage = await openStorage(values.db);
  const tenants = createTenants(storage, { secret: values.secret || process.env.WAKE_SECRET || null });
  const collectorUrl = (values.url || 'http://127.0.0.1:8790').replace(/\/+$/, '');
  try {
    if (cmd === 'org' && sub === 'create') {
      const org = await tenants.createOrg({ id: values.id, name: need('name') });
      log(`Organization ${org.id} (${org.name})`);
    } else if (cmd === 'site' && sub === 'create') {
      const config = values.config ? { ...(await loadConfig(values.config)), name: need('name') } : undefined;
      const site = await tenants.createSite({ orgId: need('org'), name: need('name'), id: values.id, config });
      const key = await tenants.issueKey(site.id);
      log(`Site ${site.id} (${site.name}), config version ${site.version}${config ? '' : ', shadow mode'}`);
      log(`API key (shown once): ${key.key}`);
    } else if (cmd === 'sites') {
      for (const s of await tenants.listSites(values.org)) log(`${s.id}\t${s.org_id}\t${s.name}`);
    } else if (cmd === 'key' && sub === 'create') {
      const k = await tenants.issueKey(need('site'));
      log(`API key ${k.id} for ${k.siteId} (shown once): ${k.key}`);
    } else if (cmd === 'key' && sub === 'import') {
      const k = await tenants.importKey(need('site'), need('key'));
      log(`Registered ${k.hint} as ${k.id} for ${k.siteId}`);
    } else if (cmd === 'key' && sub === 'rotate') {
      const graceMs = Number(values['grace-hours'] ?? 24) * HOUR;
      const k = await tenants.rotateKey(need('site'), { graceMs });
      log(`New API key ${k.id} for ${k.siteId} (shown once): ${k.key}`);
      log(`The site's other keys stop working at ${fmt(k.oldKeysExpireAt)} UTC.`);
    } else if (cmd === 'key' && sub === 'revoke') {
      const k = await tenants.revokeKey(need('id'));
      log(`Revoked ${k.id} (${k.siteId}). Collectors drop cached lookups of it within 30 seconds.`);
    } else if (cmd === 'keys') {
      for (const k of await tenants.listKeys(need('site'))) {
        const state = k.revoked_at ? `revoked ${fmt(k.revoked_at)}` : k.expires_at ? `expires ${fmt(k.expires_at)}` : 'active';
        log(`${k.id}\t${k.hint}\tcreated ${fmt(k.created_at)}\t${state}`);
      }
    } else if (cmd === 'config' && sub === 'import') {
      const { version } = await tenants.saveConfig(need('site'), await loadConfig(need('config')), { source: 'import' });
      log(`Saved config version ${version} for ${values.site}`);
    } else if (cmd === 'config' && sub === 'show') {
      const entry = await tenants.getConfig(need('site'));
      log(entry ? JSON.stringify({ version: entry.version, source: entry.source, config: entry.raw }, null, 2) : 'No config saved for this site.');
    } else if (cmd === 'token') {
      const days = Number(values.days || 30);
      const token = tenants.signToken({ site: values.site, org: values.org, ttlMs: days * 24 * HOUR });
      const path = values.site ? `/_wake/sites/${values.site}/` : '/_wake/';
      log(`${collectorUrl}${path}?token=${token}`);
      log(`Valid for ${days} days.`);
    } else {
      throw new Error(`Unknown admin command "${args.join(' ')}".\n${ADMIN_USAGE}`);
    }
  } finally {
    await storage.close();
  }
}

/** Copy all tables from one storage into another (normally SQLite into Postgres). Rows already there are skipped. */
async function copy(values, log) {
  if (!values.from || !values.to) throw new Error('wake admin copy: --from and --to are required');
  const from = await openStorage(values.from);
  if (from.dialect !== 'sqlite') throw new Error('wake admin copy: --from must be a SQLite database');
  const to = await openStorage(values.to);
  try {
    for (const table of TABLES) {
      let n = 0;
      for (let offset = 0; ; offset += 500) {
        const rows = await from.db.all(`SELECT * FROM ${table} ORDER BY rowid LIMIT 500 OFFSET ${offset}`);
        if (!rows.length) break;
        const cols = Object.keys(rows[0]);
        const values_ = rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
        await to.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values_} ON CONFLICT DO NOTHING`, rows.flatMap((r) => cols.map((c) => r[c])));
        n += rows.length;
      }
      if (to.dialect === 'postgres' && ['events', 'answers'].includes(table)) {
        await to.db.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(1, (SELECT COALESCE(MAX(id), 0) FROM ${table})))`);
      }
      log(`${table}: ${n} rows`);
    }
  } finally {
    await from.close();
    await to.close();
  }
}
