// Ingest limits for the collector: a token bucket per API key and a request body read with a size cap.
// Buckets live in the collector's memory, so with N collector instances behind a load balancer a key can
// send up to N times its limit.

/** take(key, cost) -> 0 if allowed, else the milliseconds until `cost` tokens are available. */
export function createRateLimiter({ perMinute, burst = perMinute, now = () => Date.now() }) {
  const perMs = perMinute / 60_000;
  const buckets = new Map();

  function bucket(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size > 50_000) buckets.clear();
      buckets.set(key, (b = { tokens: burst, at: t }));
    }
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * perMs);
    b.at = t;
    return b;
  }

  return {
    /** Milliseconds until one token is available (0 = go ahead). Takes nothing. */
    wait(key) {
      const b = bucket(key);
      return b.tokens >= 1 ? 0 : Math.ceil((1 - b.tokens) / perMs);
    },
    take(key, cost = 1) {
      const b = bucket(key);
      if (b.tokens >= cost) { b.tokens -= cost; return 0; }
      return Math.ceil((Math.min(cost, burst) - b.tokens) / perMs);
    },
  };
}

/** The body as text, or null when it is larger than maxBytes (checked on Content-Length and while reading). */
export async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}
