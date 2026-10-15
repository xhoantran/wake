// Telemetry leaves the customer's stack in batches, after responses are sent.
// It never throws and never blocks a page: if the collector is down, events are dropped and counted.

export function createTelemetry({
  endpoint, apiKey, fetch: fetchImpl = globalThis.fetch,
  maxBatch = 100, maxBuffer = 5000, flushMs = 2000, timeoutMs = 5000, onError = () => {},
} = {}) {
  if (!endpoint) throw new Error('wake: telemetry needs an endpoint');
  const url = endpoint.replace(/\/+$/, '') + '/v1/events';
  let buffer = [];
  let timer = null;
  let flushing = null;
  const stats = { sent: 0, dropped: 0, failedBatches: 0 };

  async function sendAll() {
    while (buffer.length) {
      const batch = buffer.splice(0, maxBatch);
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await r.arrayBuffer().catch(() => {});
        if (!r.ok) throw new Error(`collector answered ${r.status}`);
        stats.sent += batch.length;
      } catch (err) {
        stats.dropped += batch.length;
        stats.failedBatches++;
        try { onError(err); } catch { /* ignore */ }
      }
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!flushing) flushing = sendAll().finally(() => { flushing = null; });
    return flushing;
  }

  function emit(event) {
    try {
      buffer.push(event);
      if (buffer.length > maxBuffer) {
        stats.dropped += buffer.length - maxBuffer;
        buffer = buffer.slice(-maxBuffer);
      }
      if (buffer.length >= maxBatch) flush();
      else if (flushMs > 0 && !timer) {
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
    } catch { /* never let telemetry break a request */ }
  }

  return { emit, flush, stats, pending: () => buffer.length };
}

/** Telemetry that hands events straight to an in-process collector (single-server and local use). */
export function createDirectTelemetry(ingest) {
  const stats = { sent: 0, dropped: 0, failedBatches: 0 };
  return {
    emit(event) {
      try {
        const r = ingest([event]);
        stats.sent++;
        if (r && typeof r.then === 'function') r.catch(() => { stats.sent--; stats.dropped++; });
      } catch { stats.dropped++; }
    },
    flush: async () => {},
    stats,
    pending: () => 0,
  };
}
