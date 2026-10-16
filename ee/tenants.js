// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
//
// Tenants: organizations own sites, sites own API keys and a versioned config.
// API keys are shown once and stored as SHA-256 hashes. Dashboard links carry a signed token (HMAC with the
// collector's secret) for one site or for every site of an organization.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { flowed } from '../src/flow.js';
import { createSiteConfigs, ConfigError, storableConfig, validateConfig } from '../src/site-configs.js';

const DAY = 86_400_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export { storableConfig, validateConfig };
export class TenantError extends ConfigError {}

export const newApiKey = () => 'wk_live_' + randomBytes(24).toString('base64url');
const hintOf = (key) => key.slice(0, 12) + '…' + key.slice(-4);

/** "Meridian Wireless" -> "meridian-wireless-k3f9" */
function makeId(name, fallback) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

function checkId(id, what) {
  if (!ID.test(id)) throw new TenantError(`wake: ${what} ids use lowercase letters, digits, "-" and "_" (got "${id}")`);
  return id;
}

export function createTenants(storage, { secret = null, now = () => Date.now(), keyCacheMs = 30_000, configCacheMs = 5_000 } = {}) {
  const t = storage.tenants;
  const configs = createSiteConfigs(storage, { now, configCacheMs });
  const keyCache = new Map(); // key hash -> { row, at }

  function sign(payload) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  const issueKey = flowed(function* (siteId, { key } = {}) {
    if (!(yield t.getSite(siteId))) throw new TenantError(`wake: no site "${siteId}"`, 404);
    key = key || newApiKey();
    const row = { id: 'key_' + randomBytes(6).toString('hex'), siteId, hash: sha256(key), hint: hintOf(key), ts: now() };
    yield t.addKey(row);
    keyCache.delete(row.hash);
    return { id: row.id, siteId, key, hint: row.hint };
  });

  return {
    ...configs,
    secret,

    createOrg: flowed(function* ({ id, name }) {
      id = checkId(id || makeId(name, 'org'), 'organization');
      yield t.createOrg({ id, name: name || id, ts: now() });
      return { id, name: name || id };
    }),

    /** New sites start in shadow mode (observe only) unless a config is given. */
    createSite: flowed(function* ({ orgId, name, id, config }) {
      if (!(yield t.getOrg(orgId))) throw new TenantError(`wake: no organization "${orgId}"`, 404);
      id = checkId(id || makeId(name, 'site'), 'site');
      yield t.createSite({ id, orgId, name: name || id, ts: now() });
      const { version } = yield configs.saveConfig(id, config || { name: name || id, mode: 'shadow' }, { source: 'created' });
      return { id, orgId, name: name || id, version };
    }),

    listSites: (orgId) => t.listSites(orgId),

    issueKey,
    /** Pass `key` to register a key the SDKs already use (moving a single-site collector over). */
    importKey: (siteId, key) => issueKey(siteId, { key }),
    /** A new key; the site's other keys keep working for graceMs, so installs can be redeployed without losing events. */
    rotateKey: flowed(function* (siteId, { graceMs = DAY } = {}) {
      const k = yield issueKey(siteId);
      const at = now() + graceMs;
      yield t.expireOtherKeys(siteId, k.id, at);
      keyCache.clear();
      return { ...k, oldKeysExpireAt: at };
    }),
    revokeKey: flowed(function* (id) {
      const row = yield t.getKey(id);
      if (!row) throw new TenantError(`wake: no API key "${id}"`, 404);
      yield t.revokeKey(id, now());
      keyCache.clear();
      return { id, siteId: row.site_id };
    }),
    listKeys: (siteId) => t.listKeys(siteId),

    /** The site a key belongs to, or null if it is unknown, revoked or expired. Lookups are cached for keyCacheMs. */
    resolveKey: flowed(function* (key) {
      if (!key) return null;
      const hash = sha256(key);
      let hit = keyCache.get(hash);
      if (!hit || now() - hit.at > keyCacheMs) {
        if (keyCache.size > 10_000) keyCache.clear();
        hit = { row: (yield t.keyByHash(hash)) || null, at: now() };
        keyCache.set(hash, hit);
      }
      const row = hit.row;
      if (!row || row.revoked_at != null || (row.expires_at != null && Number(row.expires_at) <= now())) return null;
      return { siteId: row.site_id, keyId: row.id };
    }),

    /** A dashboard token for one site ({ site }) or every site of an organization ({ org }). */
    signToken({ site, org, ttlMs = 30 * DAY }) {
      if (!secret) throw new TenantError('wake: set a collector secret (--secret or WAKE_SECRET) to sign dashboard links');
      if (!site === !org) throw new TenantError('wake: a dashboard token is for one site or one organization');
      const payload = Buffer.from(JSON.stringify(site ? { s: site, e: now() + ttlMs } : { o: org, e: now() + ttlMs })).toString('base64url');
      return `wkd.${payload}.${sign(payload)}`;
    },
    /** { s | o, e } for a valid, unexpired token signed with this collector's secret; otherwise null. */
    verifyToken(token) {
      if (!secret || typeof token !== 'string') return null;
      const [tag, payload, sig] = token.split('.');
      if (tag !== 'wkd' || !payload || !sig) return null;
      const want = Buffer.from(sign(payload));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return Number(claims.e) > now() ? claims : null;
      } catch { return null; }
    },
  };
}
