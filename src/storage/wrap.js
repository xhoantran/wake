// Turn a SQL driver (SQLite or Postgres) into Wake's multi-site storage. No runtime-specific imports here,
// so the Cloudflare Worker collector can use it without pulling in node:sqlite.
import { siteStore, tenantStore } from './sql.js';

export function wrapStorage(db) {
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
