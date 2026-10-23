// `wake verify`: check from outside that a site runs Wake correctly.
// It visits the site as a person, as an AI agent (an honest "Wake-Verify" user-agent) and as a search crawler,
// follows a session link and a sign-up link the way an agent and a person would, and (with an API key) asks the
// collector whether those visits arrived. Every request carries `x-wake-verify: <probe id>`, so the collector keeps
// them apart from real sessions and reports.
import { CODE_RE } from './util.js';

export const VERIFY_UA = 'Mozilla/5.0 (compatible; Wake-Verify/1.0; +https://github.com/xhoantran/wake)';
const PERSON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const CRAWLER_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const ASSET_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|zip|gz|pdf)$/i;

export function newProbeId() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'VF-' + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => A[b % A.length]).join('');
}

/** "query; prefix=/a; handoffPrefix=/r; param=wk; handoffParam=wkh" -> { carrier, prefix, ... } */
export function parseCarrierHeader(value) {
  const [carrier, ...rest] = String(value || '').split(';').map((s) => s.trim());
  const out = { carrier: carrier || null, prefix: '/a', handoffPrefix: '/r', param: 'wk', handoffParam: 'wkh' };
  for (const kv of rest) {
    const [k, v] = kv.split('=');
    if (k in out && v) out[k] = v;
  }
  return out;
}

/** Navigation links of an HTML page (<a>, <area>, <form>), resolved against the page URL. */
export function pageLinks(html, pageUrl) {
  const out = [];
  for (const tag of String(html).match(/<(?:a|area|form)\b[^>]*>/gi) || []) {
    const m = tag.match(/\s(?:href|action)\s*=\s*(["'])(.*?)\1/i);
    if (!m) continue;
    const raw = m[2].replace(/&amp;/gi, '&').trim();
    if (!raw || /^(#|mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(raw)) continue;
    try { out.push({ raw, url: new URL(raw, pageUrl) }); } catch { /* not a URL */ }
  }
  return out;
}

const bare = (host) => host.replace(/^www\./, '');

/** Where a session link points once the code is taken out, and whether it is a hand-off link. */
function linkKind(url, code, names) {
  const p = url.pathname;
  for (const [prefix, handoff] of [[names.handoffPrefix, true], [names.prefix, false]]) {
    const lead = `${prefix}/${code}`;
    if (p.startsWith(lead + '/') || p.startsWith(lead + '.')) return { handoff, clean: p.slice(p.indexOf('/', prefix.length + 1)) || '/' };
  }
  for (const [param, handoff] of [[names.handoffParam, true], [names.param, false]]) {
    const v = url.searchParams.get(param);
    if (v && (v === code || v.startsWith(code + '.'))) return { handoff, clean: p };
  }
  return null;
}

/**
 * verifySite({ url, endpoint?, apiKey?, fetch?, sleep?, probe? }) ->
 *   { url, probe, mode, carrier, ok, checks: [{ id, title, status: 'pass'|'fail'|'warn'|'skip', detail }] }
 */
export async function verifySite({ url, endpoint = null, apiKey = null, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), probe = newProbeId(), attempts = 3 } = {}) {
  const page = new URL(url);
  const checks = [];
  const check = (id, title, status, detail = '') => { checks.push({ id, title, status, detail }); return status; };
  const get = (u, ua) => fetchImpl(String(u), { redirect: 'manual', headers: { 'user-agent': ua, 'x-wake-verify': probe, accept: 'text/html,*/*' } });
  const result = (extra) => ({ url: page.href, probe, ...extra, ok: !checks.some((c) => c.status === 'fail'), checks });

  // 1. A person: the page works and shows no trace of Wake.
  let person;
  try { person = await get(page, PERSON_UA); } catch (err) {
    check('reachable', 'The site answers', 'fail', `Could not reach ${page.href}: ${err.message}`);
    return result({ mode: null, carrier: null });
  }
  const personHtml = await person.text();
  check('reachable', 'The site answers', person.status < 500 ? 'pass' : 'fail', `HTTP ${person.status} for a person`);
  const leaks = ['x-wake-session', 'x-wake-mode'].filter((h) => person.headers.get(h));
  const cookie = (person.headers.getSetCookie?.() || []).some((c) => /^wake_sid=/.test(c));
  check('people-untouched', 'People get the page without Wake', !leaks.length && !cookie ? 'pass' : 'fail',
    leaks.length || cookie ? `A person got ${[...leaks, ...(cookie ? ['a wake_sid cookie'] : [])].join(', ')}` : 'No Wake headers or cookies for a person');

  // 2. An agent: the SDK is there, in which mode.
  let agent, agentHtml = '';
  for (let i = 0; i < attempts; i++) {
    agent = await get(page, VERIFY_UA);
    agentHtml = await agent.text();
    if (agent.headers.get('x-wake-mode')) break;
    if (i < attempts - 1) await sleep(1000); // a Worker that just started may still be loading its config
  }
  const mode = agent.headers.get('x-wake-mode');
  const names = parseCarrierHeader(agent.headers.get('x-wake-carrier'));
  if (!mode) {
    check('sdk', 'Wake runs on this page', 'fail', 'No Wake response headers for an agent. Check that the SDK wraps this route, that WAKE_API_KEY and WAKE_ENDPOINT are set, that the collector is reachable, and that the site is not switched off (enabled: false or WAKE_DISABLED=1).');
    return result({ mode: null, carrier: null });
  }
  check('sdk', 'Wake runs on this page', 'pass', `Mode ${mode}, links carry the code in the ${names.carrier}`);

  const sessionTest = [];
  if (mode === 'shadow') {
    const coded = pageLinks(agentHtml, page).some((l) => [names.prefix, names.handoffPrefix].some((x) => l.url.pathname.startsWith(x + '/'))
      || [names.param, names.handoffParam].some((x) => l.url.searchParams.has(x)));
    check('shadow-untouched', 'Shadow mode leaves agent pages as they are', !agent.headers.get('x-wake-session') && !coded ? 'pass' : 'fail',
      'Shadow mode only observes. Switch to trace to check session links and hand-offs.');
  } else {
    // 3. The session: code, links, caching, canonical.
    const code = agent.headers.get('x-wake-session');
    if (check('session', 'The agent gets a session', CODE_RE.test(code || '') ? 'pass' : 'fail', code ? `Session ${code}` : 'No x-wake-session header') === 'pass') {
      const links = pageLinks(agentHtml, page);
      const same = links.filter((l) => /^https?:$/.test(l.url.protocol) && bare(l.url.host) === bare(page.host) && !ASSET_EXT.test(l.url.pathname));
      const other = links.filter((l) => /^https?:$/.test(l.url.protocol) && bare(l.url.host) !== bare(page.host));
      const carried = same.filter((l) => linkKind(l.url, code, names));
      const missing = same.filter((l) => !linkKind(l.url, code, names)).map((l) => l.raw);
      check('links', 'Links on agent pages carry the session code',
        !same.length ? 'warn' : !missing.length ? 'pass' : carried.length ? 'warn' : 'fail',
        !same.length ? 'This page has no links to other pages of the site; try --path with a page that does'
          : `${carried.length} of ${same.length} same-site links carry it` + (missing.length ? `; without it: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} (fine if these are skipPaths)` : ''));
      const leaked = other.filter((l) => l.raw.includes(code));
      // Wake only codes links to origins the site lists as its own (sameSiteOrigins), so this is a question, not an error.
      const hosts = [...new Set(leaked.map((l) => l.url.host))];
      check('external-links', 'Links to other sites are left alone', leaked.length ? 'warn' : 'pass',
        leaked.length ? `Links to ${hosts.join(', ')} carry the code. Fine if ${hosts.length > 1 ? 'these are' : 'this is'} your own site (sameSiteOrigins); otherwise remove ${hosts.length > 1 ? 'them' : 'it'} from sameSiteOrigins.`
          : `${other.length} outside links, none with the code`);
      const cc = agent.headers.get('cache-control') || '';
      check('private-cache', 'Agent pages are never cached for others', /private|no-store/i.test(cc) ? 'pass' : 'fail',
        `cache-control: ${cc || '(none)'}. A shared cache would hand one session's links to the next agent.`);
      const canon = agentHtml.match(/<link\b[^>]*rel=["']?canonical["']?[^>]*>/i)?.[0].match(/href=["']([^"']+)/i)?.[1];
      check('canonical', 'The canonical URL stays clean', canon ? (canon.includes(code) ? 'fail' : 'pass') : 'warn', canon ? `canonical: ${canon}` : 'No canonical link on the agent page');

      // 4. The agent follows a link; a crawler and a person open session links.
      const next = carried.find((l) => !linkKind(l.url, code, names).handoff);
      if (next) {
        const r = await get(next.url, VERIFY_UA);
        await r.arrayBuffer().catch(() => {});
        check('session-continues', 'The session follows the agent to the next page', r.headers.get('x-wake-session') === code ? 'pass' : 'fail',
          `${next.raw} answered HTTP ${r.status} with session ${r.headers.get('x-wake-session') || '(none)'}`);
        const c = await get(next.url, CRAWLER_UA);
        const loc = c.headers.get('location') || '';
        check('crawlers-clean', 'Search crawlers are sent to the clean URL', c.status === 301 && !loc.includes(code) ? 'pass' : 'fail', `GPTBot got HTTP ${c.status}${loc ? ' to ' + loc : ''}`);
        sessionTest.push('fetch');
      } else check('session-continues', 'The session follows the agent to the next page', 'skip', 'No session link to follow on this page');

      const signup = carried.find((l) => linkKind(l.url, code, names).handoff);
      if (signup) {
        const a = await get(signup.url, VERIFY_UA);
        const p = await get(signup.url, PERSON_UA);
        const loc = p.headers.get('location') || '';
        const got = (p.headers.getSetCookie?.() || []).some((c) => c.startsWith(`wake_sid=${code}`));
        check('handoff', 'A person who opens the sign-up link is credited to the session',
          a.status === 307 && p.status === 302 && got && !loc.includes(code) ? 'pass' : 'fail',
          `Agent check: HTTP ${a.status} (want 307). Person: HTTP ${p.status} to ${loc || '(none)'}, ${got ? 'session cookie set' : 'no session cookie'}`);
        if (got) sessionTest.push('handoff');
      } else check('handoff', 'A person who opens the sign-up link is credited to the session', 'skip', 'No sign-up link (handoffPaths) on this page; run again with --path set to a page that links to sign-up');
    }
  }

  // 5. The collector: the key works and this run's visits arrived.
  if (!endpoint || !apiKey) {
    check('collector', 'Events reach the collector', 'skip', 'Pass --endpoint and --api-key to check delivery');
  } else {
    const base = endpoint.replace(/\/+$/, '');
    const auth = { authorization: `Bearer ${apiKey}` };
    let ok = false, detail = '';
    try {
      const c = await fetchImpl(base + '/v1/config', { headers: auth });
      await c.arrayBuffer().catch(() => {});
      if (c.status !== 200) detail = `The collector refused the API key (HTTP ${c.status})`;
      else {
        const want = ['fetch', ...sessionTest.filter((t) => t !== 'fetch')];
        let seen = [];
        for (let i = 0; i < 5 && !want.every((t) => seen.includes(t)); i++) {
          await sleep(i === 0 ? 1500 : 2000);
          const r = await fetchImpl(`${base}/v1/probes/${probe}`, { headers: auth });
          if (r.status === 200) seen = (await r.json()).events.map((e) => e.type);
          else await r.arrayBuffer().catch(() => {});
        }
        ok = want.every((t) => seen.includes(t));
        detail = ok ? `Received ${seen.length} events from this run (${[...new Set(seen)].join(', ')})`
          : seen.length ? `Only received ${[...new Set(seen)].join(', ')}; missing ${want.filter((t) => !seen.includes(t)).join(', ')}`
            : 'No events from this run arrived. Check that the site sends to this collector with this API key.';
      }
    } catch (err) { detail = `Could not reach the collector: ${err.message}`; }
    check('collector', 'Events reach the collector', ok ? 'pass' : 'fail', detail);
  }

  return result({ mode, carrier: names.carrier });
}

const MARK = { pass: '✓', fail: '✗', warn: '!', skip: '-' };

/** The report as plain text, one line per check. */
export function formatReport(r) {
  const lines = [`Wake verify ${r.url}  (probe ${r.probe})`];
  for (const c of r.checks) lines.push(`  ${MARK[c.status]} ${c.title}${c.detail ? `: ${c.detail}` : ''}`);
  const n = (s) => r.checks.filter((c) => c.status === s).length;
  lines.push(r.ok ? `Passed: ${n('pass')} checks, ${n('warn')} warnings, ${n('skip')} skipped.` : `Failed: ${n('fail')} of ${r.checks.length} checks.`);
  return lines.join('\n');
}
