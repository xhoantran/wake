// The Wake SDK core. It runs inside the customer's stack (their app or their CDN account).
// Every decision is local: config comes from a cached source, session state comes from the URL token,
// and events go out through telemetry after the response. Any error falls back to the original response.
import { classifyAgent } from '../agents.js';
import { mintCode, parsePrefixed, matchPath, unitHash, redact, readCookie, hashIp } from '../util.js';
import { makeUrlRewriter, rewriteHtml, rewriteMarkdown, extractTitle, ensureCanonical, hasBlock, promoteBlock, listBlocks } from '../rewrite.js';
import { scoreIntents, intentsSatisfy } from '../intent.js';
import { suggestPath, parseSitemap } from '../rescue.js';
import { decodeState, formatToken } from './token.js';

const HOP_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'];
const NULL_BODY = new Set([101, 204, 205, 304]);

export function textKind(contentType, path) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return 'html';
  if (ct.includes('text/markdown') || ct.includes('text/x-markdown')) return 'markdown';
  if (ct.includes('text/plain') && /\.(md|txt)$/i.test(path)) return 'markdown';
  return null;
}

export function copyHeaders(res) {
  const h = new Headers(res.headers);
  for (const k of HOP_HEADERS) h.delete(k);
  return h;
}

function redirect(location, status = 302, extra = {}) {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store', ...extra } });
}

/** Rebuild a request for a different URL on the same origin (used to ask the site for the clean path). */
export async function retarget(request, pathAndQuery, extraHeaders = {}) {
  const url = new URL(pathAndQuery, request.url);
  const headers = new Headers(request.headers);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();
  return new Request(url, init);
}

/**
 * source:    { get(): config | null, maybeRefresh(): Promise | null }
 * telemetry: { emit(event), flush(): Promise }
 * fetchSitemap(requestOrigin): Promise<Response>  (defaults to fetching /sitemap.xml from the site)
 * knownPaths(): string[]  extra real paths (an in-process collector passes the paths it has seen)
 */
export function createCore({ source, telemetry, fetch: fetchImpl = globalThis.fetch, fetchSitemap, knownPaths = () => [], now = () => Date.now(), log = () => {} }) {
  let sitemap = { at: -Infinity, paths: [], loading: null };

  function emit(event) {
    try { telemetry.emit({ v: 1, ...event }); } catch { /* telemetry never breaks a request */ }
  }

  async function candidatePaths(cfg, requestOrigin) {
    if (now() - sitemap.at > 10 * 60 * 1000 && !sitemap.loading) {
      sitemap.loading = (async () => {
        try {
          const r = fetchSitemap ? await fetchSitemap(requestOrigin) : await fetchImpl(requestOrigin + '/sitemap.xml', { headers: { 'user-agent': 'wake-sdk (sitemap)' } });
          if (r.ok) sitemap.paths = parseSitemap(await r.text());
        } catch { /* sitemap is optional */ }
        sitemap.at = now();
        sitemap.loading = null;
      })();
    }
    if (sitemap.loading) await Promise.race([sitemap.loading, new Promise((r) => setTimeout(r, 1000))]);
    let seen = [];
    try { seen = knownPaths(); } catch { /* optional */ }
    return [...sitemap.paths, ...cfg.knownPaths, ...seen, ...Object.values(cfg.aliases)].map(cfg.normalizePath);
  }

  function cookie(cfg, code) {
    return `${cfg.cookieName}=${encodeURIComponent(code)}; Path=/; Max-Age=${cfg.cookieDays * 86400}; HttpOnly; SameSite=Lax`;
  }

  function searchQuery(cfg, url, path) {
    if (!matchPath(cfg.search.paths, path)) return null;
    for (const p of cfg.search.params) {
      const v = url.searchParams.get(p);
      if (v) return redact(v.slice(0, 300));
    }
    return null;
  }

  /**
   * Decide what to do with a request before the site handles it.
   * Returns one of:
   *   { kind: 'pass' }                         not ours: hand to the site untouched
   *   { kind: 'respond', response }            Wake answers directly (redirects)
   *   { kind: 'agent', ctx, path }             a live agent: ask the site for ctx.path, then finishAgent
   *   { kind: 'human' | 'bot', ctx }           observe only: hand to the site, then finishObserved
   */
  function classify(request, { ip } = {}) {
    const cfg = source.get();
    if (!cfg) return { kind: 'pass' };
    const url = new URL(request.url);
    const ho = parsePrefixed(url.pathname, cfg.handoffPrefix);
    const pre = ho ? null : parsePrefixed(url.pathname, cfg.prefix);

    // Kill switch: never leave a session URL broken; send it to the clean page.
    if (cfg.enabled === false) {
      if (ho || pre) return { kind: 'respond', response: redirect((ho || pre).rest + url.search, 302) };
      return { kind: 'pass' };
    }

    const ts = now();
    const ua = request.headers.get('user-agent') || '';
    const agent = classifyAgent(ua, cfg.agents);
    const live = agent && cfg.trackKinds.includes(agent.kind);
    const ipHash = hashIp(ip, cfg.ipSalt || cfg.codePrefix);
    const who = agent ? { agent: agent.name, vendor: agent.vendor, kind: agent.kind } : {};

    if (ho) {
      const path = cfg.normalizePath(ho.rest);
      if (live) {
        // Agents often fetch a link before sharing it. That is not a hand-off.
        emit({ ts, code: ho.code, type: 'link_check', actor: 'agent', ...who, ipHash, ua, method: request.method, path, status: 307 });
        return { kind: 'respond', response: redirect(`${cfg.prefix}/${ho.token}${ho.rest}${url.search}`, 307) };
      }
      const referer = request.headers.get('referer') || '';
      emit({ ts, code: ho.code, type: 'handoff', actor: agent ? 'bot' : 'human', ...who, ipHash, ua, method: request.method, path, status: 302, data: { referer } });
      return { kind: 'respond', response: redirect(ho.rest + url.search, 302, agent ? {} : { 'set-cookie': cookie(cfg, ho.code) }) };
    }

    const cleanPath = pre ? pre.rest : url.pathname;
    const path = cfg.normalizePath(cleanPath);
    const base = { ts, ...who, ipHash, ua, method: request.method, path };

    if (live) {
      if (cfg.mode === 'shadow') {
        return { kind: 'agent', path: cleanPath + url.search, ctx: { cfg, url, cleanPath, path, base: { ...base, actor: 'agent', code: pre?.code ?? null }, shadow: true, scores: decodeState(pre?.state, cfg.intents.length) } };
      }
      const code = pre?.code || mintCode(cfg.codePrefix);
      return {
        kind: 'agent', path: cleanPath + url.search,
        ctx: { cfg, url, cleanPath, path, code, minted: !pre, scores: decodeState(pre?.state, cfg.intents.length), base: { ...base, actor: 'agent', code } },
      };
    }

    if (agent) {
      // Search engines and crawlers never keep a session URL.
      if (pre) return { kind: 'respond', response: redirect(cleanPath + url.search, 301) };
      if (cfg.botSampleRate < 1 && Math.random() >= cfg.botSampleRate) return { kind: 'pass' };
      return { kind: 'bot', ctx: { cfg, path, base: { ...base, actor: 'bot', code: null } } };
    }

    const sid = readCookie(request, cfg.cookieName);
    if (pre) {
      // A person opened a session URL directly (the agent shared an /a/ link, or it was forwarded).
      if (!sid) {
        emit({ ...base, path, actor: 'human', code: pre.code, type: 'shared', status: 302, data: { referer: request.headers.get('referer') || '' } });
        return { kind: 'respond', response: redirect(cleanPath + url.search, 302, { 'set-cookie': cookie(cfg, pre.code) }) };
      }
      return { kind: 'respond', response: redirect(cleanPath + url.search, 302) };
    }
    if (sid) return { kind: 'human', ctx: { cfg, path, base: { ...base, actor: 'human', code: sid } } };
    return { kind: 'pass' };
  }

  function matchConversion(cfg, method, path) {
    return cfg.conversions.find((c) => (c.method || 'GET').toUpperCase() === method && matchPath(c.path, path));
  }

  /** Record what a person (after a hand-off) or a crawler did. Never changes the response. */
  function finishObserved(ctx, { status, headers }) {
    try {
      const { cfg, base, path } = ctx;
      const kind = textKind(headers.get('content-type'), path);
      if (base.actor === 'bot') {
        if (kind) emit({ ...base, type: 'bot', status });
        return;
      }
      const conv = status < 400 ? matchConversion(cfg, base.method, path) : null;
      if (conv) {
        const value = Number(headers.get('x-wake-value')) || conv.value || 0;
        emit({ ...base, type: 'conversion', status, data: { name: conv.name, value } });
      } else if (kind === 'html' || status == null) emit({ ...base, type: 'fetch', status });
    } catch (err) { log(err); }
  }

  /** Turn the site's response for a live agent into the session-aware one. Fails open. */
  async function finishAgent(ctx, response) {
    const backup = NULL_BODY.has(response.status) ? response : response.clone();
    try {
      return await agentResponse(ctx, response);
    } catch (err) {
      log(err);
      emit({ ...ctx.base, type: 'error', status: response.status, data: { message: String(err?.message || err).slice(0, 300) } });
      return backup;
    }
  }

  async function agentResponse(ctx, response) {
    const { cfg, url, cleanPath, path, base } = ctx;
    const status = response.status;
    const kind = textKind(response.headers.get('content-type'), cleanPath);
    const query = searchQuery(cfg, url, path);
    const tooBig = Number(response.headers.get('content-length')) > cfg.maxTransformBytes;
    const pageScores = (q) => scoreIntents([{ path, query: q }], cfg.intents);
    const addScores = (prev, inc) => cfg.intents.map((it, i) => prev[i] + (inc.find((s) => s.id === it.id)?.score || 0));
    const asScored = (scores) => cfg.intents.map((it, i) => ({ id: it.id, label: it.label || it.id, score: scores[i] })).filter((s) => s.score > 0);

    // Shadow: observe only; the response is returned as is. The page's blocks are reported so the
    // collector, which has the session history, can work out which rules would have applied.
    if (ctx.shadow) {
      const data = { shadow: true };
      if (kind && status === 200 && !tooBig && cfg.rules.length) data.blocks = listBlocks(await response.clone().text());
      if (status === 404) emit({ ...base, type: 'not_found', status, data });
      else emit({ ...base, type: 'fetch', status, query, data });
      return response;
    }

    const conv = status < 400 ? matchConversion(cfg, base.method, path) : null;
    if (conv) emit({ ...base, type: 'conversion', status, data: { name: conv.name, value: Number(response.headers.get('x-wake-value')) || conv.value || 0 } });

    const scores = addScores(ctx.scores, pageScores(query));
    const token = formatToken(ctx.code, scores);

    // The agent asked for a page that does not exist: send it to the page it most likely meant.
    if (status === 404 && base.method === 'GET') {
      const hit = suggestPath(path, await candidatePaths(cfg, url.origin), { aliases: cfg.aliases, synonyms: cfg.synonyms, threshold: cfg.rescueThreshold });
      if (hit && cfg.mode === 'route') {
        emit({ ...base, type: 'rescue', status: 308, data: { to: hit.to, score: hit.score, minted: ctx.minted } });
        return redirect(`${cfg.prefix}/${token}${hit.to}${url.search}`, 308, { 'x-wake-session': ctx.code });
      }
      emit({ ...base, type: 'not_found', status, data: { suggestion: hit?.to ?? null, minted: ctx.minted } });
    }

    const rewriteUrl = makeUrlRewriter({
      code: token, prefix: cfg.prefix, handoffPrefix: cfg.handoffPrefix,
      handoffPaths: cfg.handoffPaths, skipPaths: [...cfg.skipPaths, `${cfg.dashboard.path}/**`],
      cleanPath, requestOrigin: url.origin, upstreamOrigin: cfg.upstreamOrigin || url.origin,
      sameOrigins: new Set([url.origin, ...(cfg.upstreamOrigin ? [cfg.upstreamOrigin] : []), ...(cfg.publicOrigin ? [new URL(cfg.publicOrigin).origin] : []), ...cfg.sameSiteOrigins]),
    });

    const out = copyHeaders(response);
    out.set('x-wake-session', ctx.code);
    out.set('cache-control', 'private, no-store');
    const loc = response.headers.get('location');
    if (loc) out.set('location', rewriteUrl(loc));

    if (!kind || base.method === 'HEAD' || tooBig) {
      if (status !== 404) emit({ ...base, type: 'fetch', status, query, data: { minted: ctx.minted, ...(tooBig ? { skipped: 'size' } : {}) } });
      return new Response(NULL_BODY.has(status) ? null : response.body, { status, headers: out });
    }

    let text = await response.text();
    const applied = [];
    const exposures = [];
    if (status === 200 && cfg.mode === 'route') {
      const scored = asScored(scores);
      for (const rule of cfg.rules) {
        if (rule.when?.path && !matchPath(rule.when.path, path)) continue;
        if (!intentsSatisfy(rule.when, scored, cfg.minIntentScore)) continue;
        if (!hasBlock(text, rule.promote)) continue;
        const arm = unitHash(`${ctx.code}:${rule.id}`) < rule.holdout ? 'holdout' : 'routed';
        exposures.push({ rule: rule.id, arm });
        if (arm === 'routed') {
          const r = promoteBlock(text, rule.promote, kind);
          text = r.text;
          if (r.applied) applied.push(rule.id);
        } else applied.push(`${rule.id} (holdout)`);
      }
    }

    if (typeof cfg.transform === 'function') {
      const t = cfg.transform(text, { path, kind, code: ctx.code, intents: asScored(scores) });
      if (typeof t === 'string') text = t;
    }

    if (status !== 404) {
      emit({ ...base, type: 'fetch', status, query, title: extractTitle(text, kind),
        data: { minted: ctx.minted, ...(applied.length ? { rules: applied } : {}), ...(exposures.length ? { exposures } : {}) } });
    }

    if (kind === 'html') {
      text = rewriteHtml(text, rewriteUrl);
      text = ensureCanonical(text, (cfg.publicOrigin || url.origin) + cleanPath);
    } else {
      text = rewriteMarkdown(text, rewriteUrl);
      out.set('link', `<${(cfg.publicOrigin || url.origin) + cleanPath}>; rel="canonical"`);
    }
    if (applied.length) out.set('x-wake-rules', applied.join(', '));
    return new Response(text, { status, headers: out });
  }

  /**
   * One call for fetch-style platforms (Workers, proxies).
   * next(request) asks the site for a page and returns its Response.
   */
  async function handle(request, { ip, next, waitUntil } = {}) {
    const background = (p) => { if (p) { if (waitUntil) waitUntil(p); else p.catch?.(() => {}); } };
    try {
      let c;
      try { c = classify(request, { ip }); } catch (err) { log(err); c = { kind: 'pass' }; }
      if (c.kind === 'respond') return c.response;
      if (c.kind === 'pass') return await next(request);
      let res;
      try {
        res = await next(c.kind === 'agent' ? await retarget(request, c.path) : request);
      } catch (err) {
        log(err);
        return new Response('The site could not be reached.', { status: 502 });
      }
      if (c.kind === 'agent') return await finishAgent(c.ctx, res);
      finishObserved(c.ctx, res);
      return res;
    } finally {
      background(telemetry.flush?.());
      background(source.maybeRefresh?.());
    }
  }

  /** Report a conversion from server code: wake.conversion(request, { name, value }). */
  function conversion(request, { name = 'conversion', value = 0 } = {}) {
    const cfg = source.get();
    const code = cfg && readCookie(request, cfg.cookieName);
    if (!code) return false;
    emit({ ts: now(), code, type: 'conversion', actor: 'server', path: new URL(request.url).pathname, data: { name, value: Number(value) || 0 } });
    return true;
  }

  return { classify, finishAgent, finishObserved, handle, conversion, source, telemetry };
}
