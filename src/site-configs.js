// A site's versioned config: the config file's content, then every edit saved from the dashboard.
// The single-site collector keeps its one site ("default") here. Wake Enterprise (ee/tenants.js) adds
// organizations, many sites, API keys and signed dashboard links on top of the same tables.
import { normalizeConfig } from './config.js';
import { flowed } from './flow.js';
import { DEFAULT_SITE } from './constants.js';

export class ConfigError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** What gets stored for a site: plain JSON (functions dropped, regular expressions as their source). */
export function storableConfig(raw) {
  return JSON.parse(JSON.stringify(raw || {}, (_k, v) => (v instanceof RegExp ? v.source : v)));
}

/** Throws ConfigError (400) with normalizeConfig's message when the config is not valid. */
export function validateConfig(raw) {
  try { return normalizeConfig(structuredClone(raw)); } catch (err) { throw new ConfigError(err.message, 400); }
}

export function createSiteConfigs(storage, { now = () => Date.now(), configCacheMs = 5_000 } = {}) {
  const t = storage.tenants;
  const configCache = new Map(); // site id -> { entry, at }

  const saveConfig = flowed(function* (siteId, raw, { baseVersion = null, source = 'api' } = {}) {
    const stored = storableConfig(raw);
    validateConfig(stored);
    if (!(yield t.getSite(siteId))) throw new ConfigError(`wake: no site "${siteId}"`, 404);
    const latest = yield t.latestConfig(siteId);
    const current = latest ? Number(latest.version) : 0;
    if (baseVersion != null && Number(baseVersion) !== current) {
      throw new ConfigError(`The config changed since you opened it (now version ${current}). Reload and apply your edits again.`, 409);
    }
    const version = current + 1;
    try {
      yield t.insertConfig({ siteId, version, config: JSON.stringify(stored), source, ts: now() });
    } catch {
      throw new ConfigError('Someone else saved the config at the same moment. Reload and apply your edits again.', 409);
    }
    configCache.delete(siteId);
    return { version };
  });

  return {
    /** The single-site setup: organization and site "default", created on first use. */
    ensureDefaultSite: flowed(function* () {
      if (!(yield t.getOrg(DEFAULT_SITE))) yield t.createOrg({ id: DEFAULT_SITE, name: 'Default', ts: now() });
      if (!(yield t.getSite(DEFAULT_SITE))) yield t.createSite({ id: DEFAULT_SITE, orgId: DEFAULT_SITE, name: 'Default site', ts: now() });
      return DEFAULT_SITE;
    }),

    getSite: (id) => t.getSite(id),

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
  };
}
