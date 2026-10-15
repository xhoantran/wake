// Next.js middleware (also works as Vercel Routing Middleware).
//   // middleware.ts
//   import { NextResponse } from 'next/server';
//   import { wakeNext } from 'wake/next';
//   const wake = wakeNext({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.wake.dev' });
//   export async function middleware(request, event) {
//     return (await wake(request, event)) ?? NextResponse.next();
//   }
// Returns undefined for everything Wake doesn't change, so Next serves it normally.
// For a live AI agent it asks the app for the clean page (marked with a bypass header so this
// middleware lets it through), rewrites it and returns it.
import { buildCore } from './shared.js';
import { retarget } from '../src/sdk/core.js';

export function wakeNext(options = {}) {
  const core = options.core || buildCore({ flushMs: 0, ...options });
  const fetchImpl = options.fetch || globalThis.fetch;
  const bypass = options.bypassSecret || crypto.randomUUID();

  async function wake(request, event) {
    if (request.headers.get('x-wake-bypass') === bypass) return undefined;
    const waitUntil = event?.waitUntil?.bind(event);
    const later = (p) => { if (p) { if (waitUntil) waitUntil(p); else p.catch?.(() => {}); } };
    try {
      const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.ip;
      const c = core.classify(request, { ip });
      if (c.kind === 'pass') return undefined;
      if (c.kind === 'respond') return c.response;
      if (c.kind === 'human' || c.kind === 'bot') {
        // Middleware runs before the page, so there is no status to report. Use wake.conversion() in
        // your order or sign-up handler to report conversions.
        core.finishObserved(c.ctx, { status: null, headers: new Headers() });
        return undefined;
      }
      let res;
      try {
        res = await fetchImpl(await retarget(request, c.path, { 'x-wake-bypass': bypass }));
      } catch {
        return undefined; // let Next serve it; the clean path still works for the agent
      }
      return await core.finishAgent(c.ctx, res);
    } catch {
      return undefined;
    } finally {
      later(core.telemetry.flush?.());
      later(core.source.maybeRefresh?.());
    }
  }

  wake.conversion = (request, data) => core.conversion(request, data);
  wake.core = core;
  return wake;
}
