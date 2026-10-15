// Proxy mode: Wake in front of a site by URL. Useful for local trials, demos and self-hosting.
// It is the SDK core with next() = "fetch the page from the upstream site".
//   With a store:            events go to an in-process collector, and the dashboard is served here.
//   With endpoint + apiKey:  events go to a remote collector, like the SDK adapters.
import { createCore, copyHeaders } from './sdk/core.js';
import { createTelemetry, createDirectTelemetry } from './sdk/telemetry.js';
import { createConfigSource } from './sdk/config-source.js';
import { createCollector } from './collector.js';
import { normalizeConfig } from './config.js';
import { isPromise } from './flow.js';

const REQUEST_HOP = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'expect', 'content-length', 'proxy-connection'];
const NULL_BODY = new Set([101, 204, 205, 304]);

export function upstreamFetcher(upstream, fetchImpl = globalThis.fetch) {
  const origin = new URL(upstream).origin;
  return async function next(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const k of REQUEST_HOP) headers.delete(k);
    headers.set('accept-encoding', 'identity');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    const init = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
    const res = await fetchImpl(origin + url.pathname + url.search, init);
    return new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status, headers: copyHeaders(res) });
  };
}

/**
 * The in-process collector's config for the proxy: the local config, overlaid with the latest version saved for
 * the site (so dashboard edits apply at once). Functions in the local config, such as transform, are kept.
 */
function liveSource(collector, userConfig) {
  let version = -1;
  let cfg = normalizeConfig(userConfig);
  const get = () => {
    const entry = collector.siteConfig();
    if (!isPromise(entry) && entry.version !== version) {
      version = entry.version;
      try { cfg = normalizeConfig({ ...userConfig, ...entry.raw }); } catch { /* keep the last good config */ }
    }
    return cfg;
  };
  return { get, maybeRefresh: () => null, refresh: async () => get() };
}

export function createWake(userConfig, { store, endpoint, apiKey, fetch: fetchImpl = globalThis.fetch, now } = {}) {
  if (!userConfig?.upstream) throw new Error('wake: config.upstream is required in proxy mode');
  const next = upstreamFetcher(userConfig.upstream, fetchImpl);
  const fetchSitemap = () => fetchImpl(new URL(userConfig.upstream).origin + '/sitemap.xml', { headers: { 'user-agent': 'wake-sdk (sitemap)' } });

  if (store) {
    const collector = createCollector({ config: userConfig, store, now });
    const knownPaths = () => { const p = collector.store.knownPaths(); return isPromise(p) ? [] : p; };
    const core = createCore({ source: liveSource(collector, userConfig), telemetry: createDirectTelemetry(collector.ingest), fetchSitemap, knownPaths, now });
    const dash = collector.config.dashboard.path;
    async function handle(request, { ip } = {}) {
      const path = new URL(request.url).pathname;
      if (path === dash || path.startsWith(dash + '/')) return collector.handle(request, { ip });
      return core.handle(request, { ip, next });
    }
    return { handle, config: collector.config, store, collector, core };
  }

  if (!endpoint || !apiKey) throw new Error('wake: pass a store (local collector) or an endpoint and apiKey (remote collector)');
  const telemetry = createTelemetry({ endpoint, apiKey, fetch: fetchImpl });
  const source = createConfigSource({ config: userConfig, endpoint, apiKey, fetch: fetchImpl });
  const core = createCore({ source, telemetry, fetchSitemap, now });
  return { handle: (request, { ip } = {}) => core.handle(request, { ip, next }), config: source.get(), core, telemetry, source };
}
