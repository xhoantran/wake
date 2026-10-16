// The Wake collector: it receives SDK events, builds sessions, serves the SDK its config, and runs the dashboard.
// Customer sites never wait on it.
//
// Single site:  createCollector({ config, store, apiKeys })   the config and keys become site "default".
// Many sites:   Wake Enterprise passes a `tenancy` plugin (ee/collector.js: createHostedCollector) that resolves
//               API keys to sites, verifies signed dashboard links and serves the organization index.
import { normalizeConfig } from './config.js';
import { handleSiteDashboard, unauthorized } from './dashboard.js';
import { scoreIntents, intentsSatisfy } from './intent.js';
import { mintCode, json, matchPath } from './util.js';
import { flow, flowed, isPromise, createSerial } from './flow.js';
import { createSiteConfigs, storableConfig } from './site-configs.js';
import { DEFAULT_SITE } from './constants.js';
import { createRateLimiter, readBody } from './limits.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
const TYPES = new Set(['fetch', 'rescue', 'not_found', 'handoff', 'link_check', 'shared', 'conversion', 'bot', 'error', 'brief']);
const DAY = 86_400_000;

export const DEFAULT_LIMITS = {
  maxEvents: 1000,              // events per POST /v1/events
  maxBodyBytes: 1_000_000,      // bytes per POST /v1/events
  eventsPerMinute: 60_000,      // per API key, with bursts up to the same number
  maxEventAgeMs: 7 * DAY,       // older events are rejected
  maxClockSkewMs: 5 * 60_000,   // events dated more than this ahead of the collector's clock are rejected
};

/** Config the SDK may see: no dashboard token, no answer-check settings, nothing local to one deployment. */
export function publicConfig(raw, version) {
  const { dashboard: _d, answerChecks: _a, transform: _t, upstream: _u, ...rest } = raw;
  return { ...storableConfig(rest), ...(version ? { version } : {}) };
}

function bearer(request) {
  return (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * tenancy (Wake Enterprise): {
 *   secret,                       turns off the localhost shortcuts when set
 *   resolveKey(key)            -> { siteId, keyId } | null   (value or promise)
 *   verifyToken(token)         -> { s: siteId } | { o: orgId } | null
 *   handleIndex(request, ctx)  -> Response                    the multi-site front page
 * }
 * configs: the site config store to use (defaults to src/site-configs.js; Enterprise passes its tenants).
 */
export function createCollector({
  config, store, storage, apiKeys = [], tenancy = null, configs = null, limits = {}, dashboardPath,
  configCacheMs, now = () => Date.now(), log = () => {},
} = {}) {
  storage = storage || store?.storage;
  if (!storage) throw new Error('wake: createCollector needs a storage (openStorage) or a store (openStore)');
  const single = Boolean(config);
  if (!single && !tenancy) throw new Error('wake: pass a config for a single-site collector; many sites need Wake Enterprise (ee/collector.js)');
  const secret = tenancy?.secret || null;
  const defaultSite = single ? store?.siteId || DEFAULT_SITE : null;
  const legacyCfg = single ? normalizeConfig(config) : null; // throws on a bad config, as before
  const dash = dashboardPath || legacyCfg?.dashboard.path || '/_wake';
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const siteConfigs = configs || createSiteConfigs(storage, { now, configCacheMs });
  const limiter = createRateLimiter({ perMinute: lim.eventsPerMinute, now });
  const serial = createSerial();
  const legacyKeys = new Set(apiKeys.filter(Boolean));

  // Single-site: make sure site "default" exists and holds the config file's content.
  // A config edited in the dashboard since then wins over the file (see `wake admin config import`).
  const ready = single ? flow((function* () {
    yield siteConfigs.ensureDefaultSite();
    const want = storableConfig(config);
    const current = yield siteConfigs.getConfig(defaultSite, { fresh: true });
    if (!current || (current.source !== 'dashboard' && JSON.stringify(current.raw) !== JSON.stringify(want))) {
      yield siteConfigs.saveConfig(defaultSite, want, { source: 'file' });
    } else if (JSON.stringify(current.raw) !== JSON.stringify(want)) {
      log(`wake: site "${defaultSite}" has a config saved in the dashboard (version ${current.version}); the config file is not applied.`);
    }
  })()) : null;
  if (isPromise(ready)) ready.catch((err) => log(`wake: collector setup failed: ${err.message}`));

  /** { version, raw, config } for a site; sites without a saved config get the defaults. */
  const siteConfig = flowed(function* (siteId = defaultSite) {
    const entry = yield siteConfigs.getConfig(siteId);
    return entry || { version: 0, raw: {}, config: normalizeConfig({}) };
  });

  function* shadowSession(store, cfg, ev) {
    const s = yield store.findMergeCandidate(ev.ipHash, ev.agent, ev.ua, ev.ts - cfg.shadowWindowMs);
    if (s) return s.code;
    let code;
    do { code = mintCode('SH'); } while (yield store.getSession(code));
    yield store.createSession({ code, ts: ev.ts, agent: { name: ev.agent, vendor: ev.vendor, kind: ev.kind }, ip: ev.ipHash, ua: ev.ua, origin: 'shadow' });
    return code;
  }

  /** 'accepted', 'ignored' (malformed, or no session to join) or 'rejected' (too old or in the future). */
  function* apply(store, cfg, ev, t) {
    if (!ev || !TYPES.has(ev.type) || !Number.isFinite(ev.ts)) return 'ignored';
    if (ev.ts < t - lim.maxEventAgeMs || ev.ts > t + lim.maxClockSkewMs) return 'rejected';
    ev = { ...ev, ts: Math.trunc(ev.ts) };
    const row = {
      ts: ev.ts, type: ev.type, actor: ev.actor, agent: ev.agent, vendor: ev.vendor, ip: ev.ipHash, ua: ev.ua,
      method: ev.method, path: ev.path, query: ev.query, status: ev.status, title: ev.title, data: ev.data,
    };
    if (ev.type === 'bot') { yield store.addEvent({ ...row, code: null }); return 'accepted'; }

    let code = ev.code;
    if (!code && ev.data?.shadow && ev.actor === 'agent') code = yield* shadowSession(store, cfg, ev);
    if (!code) return 'ignored';
    let s = yield store.getSession(code);
    if (!s) {
      // Only an agent's own read can start a session; anything else with an unknown code is ignored.
      if (ev.actor !== 'agent') return 'ignored';
      s = yield store.createSession({ code, ts: ev.ts, agent: { name: ev.agent, vendor: ev.vendor, kind: ev.kind }, ip: ev.ipHash, ua: ev.ua, origin: ev.data?.minted ? 'minted' : 'resumed' });
    }
    if (ev.ts > s.last_seen) yield store.touch(code, ev.ts);
    let intents = null;
    if (ev.actor === 'agent' && ev.type === 'fetch') {
      const reads = (yield store.events(code)).filter((e) => e.type === 'fetch' && e.actor === 'agent');
      intents = scoreIntents([...reads, { path: ev.path, query: ev.query }], cfg.intents);
      if (ev.data?.shadow && Array.isArray(ev.data.blocks)) {
        // Shadow mode: decide here which rules would have fired, using the whole session's intents.
        row.data = { ...row.data, wouldApply: cfg.rules
          .filter((r) => ev.data.blocks.includes(r.promote) && (!r.when?.path || matchPath(r.when.path, ev.path)) && intentsSatisfy(r.when, intents, cfg.minIntentScore))
          .map((r) => r.id) };
      }
    }
    yield store.addEvent({ ...row, code });
    for (const x of ev.data?.exposures || []) yield store.recordExposure(code, x.rule, x.arm, true, ev.ts);
    if ((ev.type === 'handoff' || ev.type === 'shared') && ev.actor === 'human') yield store.markHandoff(code, ev.ts, ev.data?.referer || '');
    if (ev.type === 'conversion') yield store.markConversion(code, ev.ts, Number(ev.data?.value) || 0);
    if (intents) yield store.setIntents(code, intents);
    return 'accepted';
  }

  function* ingestOf(siteId, events) {
    if (isPromise(ready)) yield ready;
    const store = storage.site(siteId);
    const { config: cfg } = yield siteConfig(siteId);
    const counts = { accepted: 0, ignored: 0, rejected: 0 };
    const t = now();
    for (const ev of events) {
      try { counts[yield* apply(store, cfg, ev, t)]++; } catch { counts.ignored++; }
    }
    return counts;
  }

  /**
   * Write events to one site: { accepted, ignored, rejected }. A value with SQLite, a promise with Postgres.
   * Batches for the same site are applied one after another.
   */
  function ingest(events, { siteId = defaultSite } = {}) {
    if (!siteId) throw new Error('wake: ingest needs a siteId on a multi-site collector');
    return serial(siteId, () => flow(ingestOf(siteId, events)));
  }

  /** { siteId, keyId } for the request's API key, or null. */
  async function authorizeKey(request, ip) {
    const key = bearer(request);
    if (key && legacyKeys.has(key)) return { siteId: defaultSite, keyId: 'flag:' + key.slice(-8) };
    const hit = key && tenancy ? await tenancy.resolveKey(key) : null;
    if (hit) return hit;
    // A single-site collector started without keys (and without a secret) takes events from this machine only.
    if (single && !legacyKeys.size && !secret && LOOPBACK.has(ip)) return { siteId: defaultSite, keyId: 'loopback' };
    return null;
  }

  async function handleApi(request, url, ip) {
    const who = await authorizeKey(request, ip);
    if (!who) return json({ error: 'Send your Wake API key as "Authorization: Bearer <key>".' }, { status: 401 });

    if (url.pathname === '/v1/config' && request.method === 'GET') {
      const entry = await siteConfig(who.siteId);
      const etag = `W/"${who.siteId}.${entry.version}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
      return json(publicConfig(entry.raw, entry.version), { headers: { etag, 'cache-control': 'no-cache' } });
    }

    if (url.pathname === '/v1/events' && request.method === 'POST') {
      const tooFast = (ms, limit) => json({ error: `Rate limit: ${limit} events per minute for this API key. Retry later.` },
        { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(ms / 1000))) } });
      const wait = limiter.wait(who.keyId);
      if (wait) return tooFast(wait, lim.eventsPerMinute);
      const text = await readBody(request, lim.maxBodyBytes);
      if (text === null) return json({ error: `Send at most ${lim.maxBodyBytes} bytes per request.` }, { status: 413 });
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'Send JSON: { "events": [...] }' }, { status: 400 }); }
      const events = Array.isArray(body?.events) ? body.events : null;
      if (!events) return json({ error: 'Send JSON: { "events": [...] }' }, { status: 400 });
      if (events.length > lim.maxEvents) return json({ error: `Send at most ${lim.maxEvents} events per request.` }, { status: 413 });
      const later = limiter.take(who.keyId, Math.max(1, events.length));
      if (later) return tooFast(later, lim.eventsPerMinute);
      return json(await ingest(events, { siteId: who.siteId }), { status: 202 });
    }
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  /** Whether the request may open this site's dashboard. */
  function canOpen(request, ip, site, legacyToken) {
    const offered = [bearer(request), ...readCookies(request, 'wake_dash')].filter(Boolean);
    for (const token of offered) {
      if (legacyToken && token === legacyToken) return true;
      const claims = tenancy?.verifyToken(token);
      if (site && claims && (claims.s === site.id || (claims.o && claims.o === site.org_id))) return true;
    }
    return !legacyToken && !secret && LOOPBACK.has(ip);
  }

  async function handleDashboard(request, url, ip) {
    const rest = url.pathname.slice(dash.length) || '/';
    const m = rest.match(/^\/sites\/([a-z0-9][a-z0-9_-]{0,63})(\/.*)?$/);
    if (!m && !defaultSite) return tenancy.handleIndex(request, { url, base: dash, ip, secret, local: !secret && LOOPBACK.has(ip), readCookies });
    const siteId = m ? m[1] : defaultSite;
    const base = m ? `${dash}/sites/${siteId}` : dash;
    const sub = m ? m[2] || '/' : rest;

    const site = await siteConfigs.getSite(siteId);
    const entry = await siteConfig(siteId);
    const legacyToken = entry.config.dashboard.token;
    const linkToken = url.searchParams.get('token');
    if (linkToken && site) {
      const claims = tenancy?.verifyToken(linkToken);
      if (linkToken === legacyToken || (claims && (claims.s === site.id || claims.o === site.org_id))) {
        const secure = url.protocol === 'https:' ? '; Secure' : '';
        return new Response(null, { status: 302, headers: { location: base + '/', 'set-cookie': `wake_dash=${linkToken}; Path=${base}; HttpOnly; SameSite=Strict${secure}` } });
      }
    }
    if (!canOpen(request, ip, site, legacyToken)) return unauthorized({ legacyToken, secret });
    if (!site) return json({ error: 'No such site' }, { status: 404 });
    return handleSiteDashboard(request, { sub, site, entry, store: storage.site(siteId), configs: siteConfigs });
  }

  async function handle(request, { ip } = {}) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    const isDash = url.pathname === dash || url.pathname.startsWith(dash + '/');
    if (!isDash && url.pathname !== '/v1/events' && url.pathname !== '/v1/config') return json({ error: 'Not found' }, { status: 404 });
    if (isPromise(ready)) await ready;
    return isDash ? handleDashboard(request, url, ip) : handleApi(request, url, ip);
  }

  return {
    handle, ingest, siteConfig, configs: siteConfigs, storage, ready,
    config: legacyCfg, store: single ? storage.site(defaultSite) : null, defaultSite, dashboardPath: dash, limits: lim,
  };
}

/** Every value of a cookie (a site cookie and an organization cookie can both be sent). */
export function readCookies(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return [];
  const out = [];
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { out.push(decodeURIComponent(v.join('='))); } catch { /* skip a malformed cookie */ } }
  }
  return out;
}
