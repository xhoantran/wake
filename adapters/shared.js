import { createCore } from '../src/sdk/core.js';
import { createTelemetry } from '../src/sdk/telemetry.js';
import { createConfigSource } from '../src/sdk/config-source.js';

/**
 * Build an SDK core from adapter options:
 *   { apiKey, endpoint }   send events to the Wake collector and pull its config (Datadog-style)
 *   { config }             local rules (optional with an endpoint; required without one)
 *   { telemetry }          custom telemetry sink (tests, self-hosting)
 *   { flushMs }            batch window; 0 = flush only when the platform calls flush (Workers)
 */
export function buildCore({ apiKey, endpoint, config, telemetry, fetch: fetchImpl = globalThis.fetch, flushMs = 2000, refreshMs, log, now, fetchSitemap } = {}) {
  const sink = telemetry || (endpoint ? createTelemetry({ endpoint, apiKey, fetch: fetchImpl, flushMs, onError: log }) : null);
  if (!sink) throw new Error('wake: pass { apiKey, endpoint } (or a telemetry sink)');
  const source = createConfigSource({ config, endpoint, apiKey, fetch: fetchImpl, refreshMs, now });
  if (!config) source.maybeRefresh(); // first pull; requests pass through untouched until it lands
  return createCore({ source, telemetry: sink, fetch: fetchImpl, log, now, fetchSitemap });
}
