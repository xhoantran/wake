import { normalizeConfig } from '../config.js';

/**
 * Where the SDK gets its rules. A local config works on its own. With an endpoint and API key,
 * the SDK also pulls the config managed in the Wake dashboard, in the background, and keeps the
 * last good copy if the collector is unreachable. Until any config is available, the SDK passes
 * every request through untouched.
 */
export function createConfigSource({ config, endpoint, apiKey, refreshMs = 60_000, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  let current = config ? normalizeConfig(config) : null;
  let fetchedAt = 0;
  let loading = null;
  let etag = null;

  async function refresh() {
    if (!endpoint) return current;
    try {
      const headers = { authorization: `Bearer ${apiKey}` };
      if (etag && current) headers['if-none-match'] = etag; // 304 when the site's config version is unchanged
      const r = await fetchImpl(endpoint.replace(/\/+$/, '') + '/v1/config', { headers, signal: AbortSignal.timeout(3000) });
      if (r.status === 200) {
        current = normalizeConfig({ ...(config || {}), ...(await r.json()) });
        etag = r.headers.get('etag');
      } else await r.arrayBuffer().catch(() => {});
    } catch { /* keep the last good config */ }
    fetchedAt = now();
    return current;
  }

  return {
    get: () => current,
    /** Start a background refresh when the copy is stale. Returns the promise (for waitUntil) or null. */
    maybeRefresh() {
      if (!endpoint || loading || now() - fetchedAt < refreshMs) return null;
      loading = refresh().finally(() => { loading = null; });
      return loading;
    },
    refresh,
  };
}

export function staticSource(config) {
  const cfg = normalizeConfig(config);
  return { get: () => cfg, maybeRefresh: () => null, refresh: async () => cfg };
}
