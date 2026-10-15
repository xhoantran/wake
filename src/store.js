// Storage entry points.
//   openStorage('wake.db')               SQLite, synchronous: local trials and self-hosting
//   await openStorage('postgres://…')    Postgres: the hosted collector
// A storage holds every tenant. storage.site(id) is the only way to its sessions and events, and every query
// it runs is scoped by site_id. storage.tenants manages organizations, sites, API keys and site configs.
import { openSqlite } from './storage/sqlite.js';
import { siteStore, tenantStore } from './storage/sql.js';

export const DEFAULT_SITE = 'default';

const isPostgres = (target) => typeof target === 'string' ? /^postgres(ql)?:\/\//i.test(target) : typeof target?.query === 'function';

function wrap(db) {
  const sites = new Map();
  return {
    dialect: db.dialect,
    db,
    tenants: tenantStore(db),
    site(siteId) {
      let s = sites.get(siteId);
      if (!s) sites.set(siteId, (s = siteStore(db, siteId)));
      return s;
    },
    close: () => db.close(),
  };
}

/** A SQLite path (or ':memory:') returns the storage; a postgres:// URL or a pg.Pool returns a promise of it. */
export function openStorage(target = ':memory:', options = {}) {
  if (isPostgres(target)) return import('./storage/postgres.js').then(({ openPostgres }) => openPostgres(target, options)).then(wrap);
  return wrap(openSqlite(target, options));
}

/**
 * Single-site SQLite store, as before sites existed: the "default" site of a SQLite storage.
 * `db` is the node:sqlite handle; `storage` is the whole multi-site storage behind it.
 */
export function openStore(path = ':memory:') {
  const storage = openStorage(path);
  return { ...storage.site(DEFAULT_SITE), db: storage.db.raw, storage, close: storage.close };
}
