// Cloudflare Worker, deployed in the customer's own Cloudflare account on their site's route.
//   // worker.js
//   import { createWorker } from 'wake/worker';
//   export default createWorker();   // reads WAKE_API_KEY and WAKE_ENDPOINT from env
// Requests to the same zone from a Worker go to the origin, so next() is just fetch().
// Events are flushed with ctx.waitUntil after the response is sent. Set the route's failure mode
// to "fail open" in Cloudflare so the site keeps serving even if the Worker itself fails.
import { buildCore } from './shared.js';

export function createWorker(options = {}) {
  let core = options.core || null;
  const fetchImpl = options.fetch || ((req) => fetch(req));

  return {
    async fetch(request, env = {}, ctx = {}) {
      if (!core) {
        core = buildCore({
          apiKey: options.apiKey || env.WAKE_API_KEY,
          endpoint: options.endpoint || env.WAKE_ENDPOINT,
          config: options.config,
          telemetry: options.telemetry,
          fetch: options.fetch,
          flushMs: 0,
        });
      }
      if (env.WAKE_DISABLED === '1') return fetchImpl(request);
      const ip = request.headers.get('cf-connecting-ip') || '';
      return core.handle(request, { ip, next: (req) => fetchImpl(req), waitUntil: ctx.waitUntil?.bind(ctx) });
    },
  };
}
