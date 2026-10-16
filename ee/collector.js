// Wake Enterprise. Licensed under ee/LICENSE, not Apache-2.0.
//
// The hosted, multi-site collector: the core collector plus organizations, many sites, API keys,
// signed dashboard links and the organization index.
import { createCollector } from '../src/collector.js';
import { createTenants } from './tenants.js';
import { handleIndex } from './dashboard-index.js';

export function createHostedCollector({ storage, secret = null, keyCacheMs, configCacheMs, now = () => Date.now(), ...rest } = {}) {
  const tenants = createTenants(storage, { secret, now, keyCacheMs, configCacheMs });
  const tenancy = {
    secret,
    resolveKey: (key) => tenants.resolveKey(key),
    verifyToken: (token) => tenants.verifyToken(token),
    handleIndex: (request, ctx) => handleIndex(request, { ...ctx, tenants }),
  };
  const collector = createCollector({ ...rest, storage, tenancy, configs: tenants, now });
  return { ...collector, tenants };
}
