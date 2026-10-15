// Tenants: organizations own sites, sites own API keys and a versioned config.
// API keys are shown once and stored as SHA-256 hashes. Dashboard links carry a signed token (HMAC with the
// collector's secret) for one site or for every site of an organization.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeConfig } from './config.js';
import { flowed } from './flow.js';
import { DEFAULT_SITE } from './store.js';

const DAY = 86_400_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class TenantError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

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

/** What gets stored for a site: plain JSON (functions dropped, regular expressions as their source). */
export function storableConfig(raw) {
  return JSON.parse(JSON.stringify(raw || {}, (_k, v) => (v instanceof RegExp ? v.source : v)));
}

/** Throws TenantError (400) with normalizeConfig's message when the config is not valid. */
export function validateConfig(raw) {
  try { return normalizeConfig(structuredClone(raw)); } catch (err) { throw new TenantError(err.message, 400); }
}

export function createTenants(storage, { secret = null, now = () => Date.now(), keyCacheMs = 30_000, configCacheMs = 5_000 } = {}) {
  const t = storage.tenants;
  const keyCache = new Map();    // key hash -> { row, at }
  const configCache = new Map(); // site id -> { entry, at }

  function sign(payload) {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  const saveConfig = flowed(function* (siteId, raw, { baseVersion = null, source = 'api' } = {}) {
    const stored = storableConfig(raw);
    validateConfig(stored);
    if (!(yield t.getSite(siteId))) throw new TenantError(`wake: no site "${siteId}"`, 404);
    const latest = yield t.latestConfig(siteId);
    const current = latest ? Number(latest.version) : 0;
    if (baseVersion != null && Number(baseVersion) !== current) {
      throw new TenantError(`The config changed since you opened it (now version ${current}). Reload and apply your edits again.`, 409);
    }
    const version = current + 1;
    try {
      yield t.insertConfig({ siteId, version, config: JSON.stringify(stored), source, ts: now() });
    } catch {
      throw new TenantError('Someone else saved the config at the same moment. Reload and apply your edits again.', 409);
    }
    configCache.delete(siteId);
    return { version };
  });

  const issueKey = flowed(function* (siteId, { key } = {}) {
    if (!(yield t.getSite(siteId))) throw new TenantError(`wake: no site "${siteId}"`, 404);
    key = key || newApiKey();
    const row = { id: 'key_' + randomBytes(6).toString('hex'), siteId, hash: sha256(key), hint: hintOf(key), ts: now() };
    yield t.addKey(row);
    keyCache.delete(row.hash);
    return { id: row.id, siteId, key, hint: row.hint };
  });

  return {
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
      const { version } = yield saveConfig(id, config || { name: name || id, mode: 'shadow' }, { source: 'created' });
      return { id, orgId, name: name || id, version };
    }),

    /** The single-site setup: organization and site "default", created on first use. */
    ensureDefaultSite: flowed(function* () {
      if (!(yield t.getOrg(DEFAULT_SITE))) yield t.createOrg({ id: DEFAULT_SITE, name: 'Default', ts: now() });
      if (!(yield t.getSite(DEFAULT_SITE))) yield t.createSite({ id: DEFAULT_SITE, orgId: DEFAULT_SITE, name: 'Default site', ts: now() });
      return DEFAULT_SITE;
    }),

    getSite: (id) => t.getSite(id),
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

    /** The latest config of a site: { version, raw, config (normalized), source, createdAt }, or null. Cached for configCacheMs. */
    getConfig: flowed(function* (siteId, { fresh = false } = {}) {
      const hit = configCache.get(siteId);
      if (hit && !fresh && now() - hit.at <= configCacheMs) return hit.entry;
      const row = yield t.latestConfig(siteId);
      const entry = row ? {
        version: Number(row.version), raw: JSON.parse(row.config), config: normalizeConfig(JSON.parse(row.config)),
        source: row.source, createdAt: Number(row.created_at),
      } : null;
      configCache.set(siteId, { entry, at: now() });
      return entry;
    }),
    saveConfig,
    configHistory: (siteId, limit) => t.configHistory(siteId, limit),

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
