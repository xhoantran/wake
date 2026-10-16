// Storage entry points.
//   openStorage('wake.db')               SQLite, synchronous: local trials and self-hosting
//   Postgres is part of Wake Enterprise: ee/storage.js (openHostedStorage)
// A storage holds every tenant. storage.site(id) is the only way to its sessions and events, and every query
// it runs is scoped by site_id. storage.tenants manages organizations, sites, API keys and site configs.
import { openSqlite } from './storage/sqlite.js';
import { wrapStorage } from './storage/wrap.js';
import { DEFAULT_SITE } from './constants.js';

export { DEFAULT_SITE };

export const isPostgres = (target) => typeof target === 'string' ? /^postgres(ql)?:\/\//i.test(target) : typeof target?.query === 'function';

const wrap = wrapStorage;

/** A SQLite path (or ':memory:') returns the storage. */
export function openStorage(target = ':memory:', options = {}) {
  if (isPostgres(target)) throw new Error('wake: Postgres storage is part of Wake Enterprise; use openHostedStorage from ee/storage.js (see ee/LICENSE)');
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
