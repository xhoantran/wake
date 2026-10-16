// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
//
// Storage for the hosted collector: Postgres (connection string or pg.Pool), or SQLite for small setups.
import { openStorage, isPostgres } from '../src/store.js';
import { wrapStorage } from '../src/storage/wrap.js';

/** A postgres:// URL or a pg.Pool returns a promise of the storage; anything else opens SQLite (a value). */
export function openHostedStorage(target = ':memory:', options = {}) {
  if (isPostgres(target)) return import('./storage/postgres.js').then(({ openPostgres }) => openPostgres(target, options)).then(wrapStorage);
  return openStorage(target, options);
}
