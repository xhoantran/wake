// Dashboard pages and API for one site. The collector decides who may open which site (src/collector.js)
// and hands this module that site's scoped store, so every query here stays inside the site.
import { json } from './util.js';
import { overview, listSessions, sessionDetail, listAnswers } from './reports.js';

const EDITABLE = ['mode', 'intents', 'blocks', 'rules'];

export function unauthorized({ legacyToken, secret }) {
  if (legacyToken) return new Response('Add ?token=… to open the Wake dashboard.', { status: 401 });
  if (secret) return new Response('Open this dashboard with the link from "wake admin token" (it signs you in for 30 days).', { status: 401 });
  return new Response('The Wake dashboard is only open on localhost until you set dashboard.token.', { status: 403 });
}

/** One site's dashboard: sub is the path below the site's dashboard base ("/", "/api/overview", ...). */
export async function handleSiteDashboard(request, { sub, site, entry, store, configs }) {
  const url = new URL(request.url);
  const config = entry.config;
  if (sub === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  if (sub === '/api/overview') {
    const since = Number(url.searchParams.get('since')) || 0;
    return json(await overview(store, config, { since }));
  }
  if (sub === '/api/answers') return json(await listAnswers(store, { run: Number(url.searchParams.get('run')) || 0 }));
  if (sub === '/api/sessions') return json(await listSessions(store, { limit: Math.min(1000, Number(url.searchParams.get('limit')) || 100) }));
  const m = sub.match(/^\/api\/sessions\/([A-Z0-9-]+)$/);
  if (m) {
    const d = await sessionDetail(store, config, m[1]);
    return d ? json(d) : json({ error: 'No session with that code' }, { status: 404 });
  }
  if (sub === '/api/convert' && request.method === 'POST') {
    // Server-side conversion hook: POST { code, name, value }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON: { code, name, value }' }, { status: 400 }); }
    const s = body?.code && await store.getSession(String(body.code));
    if (!s) return json({ error: 'No session with that code' }, { status: 404 });
    const ts = Date.now();
    await store.addEvent({ ts, code: s.code, type: 'conversion', actor: 'server', data: { name: body.name || 'conversion', value: Number(body.value) || 0 } });
    await store.markConversion(s.code, ts, Number(body.value) || 0);
    return json({ ok: true });
  }
  if (sub === '/api/config' && request.method === 'GET') {
    const raw = entry.raw;
    return json({
      site: { id: site.id, name: site.name }, version: entry.version, source: entry.source || null, savedAt: entry.createdAt || null,
      mode: config.mode, intents: raw.intents || [], blocks: raw.blocks || {}, rules: raw.rules || [],
      history: await configs.configHistory(site.id, 10),
    });
  }
  if (sub === '/api/config' && request.method === 'POST') {
    // JSON only: a cross-site form post cannot send it without a preflight.
    if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Send JSON' }, { status: 415 });
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Send JSON: { baseVersion, mode, intents, blocks, rules }' }, { status: 400 }); }
    const next = { ...entry.raw };
    for (const k of EDITABLE) if (body?.[k] !== undefined) next[k] = body[k];
    try {
      const saved = await configs.saveConfig(site.id, next, { baseVersion: body?.baseVersion ?? null, source: 'dashboard' });
      return json({ ok: true, version: saved.version });
    } catch (err) {
      return json({ error: err.message }, { status: err.status || 500 });
    }
  }
  return json({ error: 'Not found' }, { status: 404 });
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wake</title>
<style>
:root{--bg:#fbfbfc;--surface:#fff;--fill:#f2f2f4;--sel:#eeeef1;--line:#e7e7ea;--ink:#17181b;--ink2:#505257;--ink3:#6a6c72;--accent:#2d62cf;--mark:#5b8def;--markbg:rgba(91,141,239,.16);--good:#17744a;--warn:#9a5200;--bad:#c2303a;--s1:#7b7e86;--s2:#a9acb3;--s3:#d3d5da;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--surface:#17171a;--fill:#202023;--sel:#26262a;--line:#2b2b30;--ink:#ededef;--ink2:#b0b1b6;--ink3:#8f9096;--accent:#8cb0ff;--mark:#6f9bf5;--markbg:rgba(111,155,245,.2);--good:#5bd49a;--warn:#ffb454;--bad:#ff8088;--s1:#8f9096;--s2:#5c5e65;--s3:#3a3b41;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/20px var(--sans)}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line)}
.bar{max-width:1200px;margin:0 auto;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;font-size:18px;letter-spacing:-.01em}.site{color:var(--ink3);font-family:var(--mono);font-size:12px}
nav{display:flex;gap:4px;margin-left:auto}nav a{color:var(--ink2);text-decoration:none;padding:6px 12px;border-radius:999px}nav a.on{background:var(--sel);color:var(--ink)}
main{max-width:1200px;margin:0 auto;padding:20px;display:grid;gap:16px}
h2{font-size:15px;margin:0}h3{font-size:13px;margin:0;color:var(--ink2);font-weight:600}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;display:grid;gap:12px;align-content:start;min-width:0}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.wide{grid-column:1/-1}
@media(max-width:860px){.grid{grid-template-columns:1fr}}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
@media(max-width:900px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
.kpi{padding:14px 16px;border-right:1px solid var(--line);display:grid;gap:2px}.kpi:last-child{border-right:0}
.kpi b{font-size:24px;line-height:30px;font-variant-numeric:tabular-nums}.small{font-size:12px;line-height:16px;color:var(--ink3)}
.mono{font-family:var(--mono);font-size:12px}
table{border-collapse:collapse;width:100%}th{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3);text-align:left;font-weight:600;padding:0 8px 6px 0;border-bottom:1px solid var(--line)}
td{padding:8px 8px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.r{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto}
.hbar{height:6px;background:var(--fill);border-radius:3px;margin-top:5px;position:relative}.hbar i{position:absolute;inset:0 auto 0 0;background:var(--mark);border-radius:3px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--fill);white-space:nowrap}
.pill:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.ok{color:var(--good)}.wait{color:var(--warn)}.no{color:var(--bad)}.go{color:var(--accent)}
.funnel{display:grid;gap:8px}.frow{display:grid;grid-template-columns:170px minmax(0,1fr) 70px;gap:10px;align-items:center}
.ftrack{height:18px;background:var(--fill);border-radius:4px;position:relative}.ftrack i{position:absolute;inset:0 auto 0 0;background:var(--s1);border-radius:4px}.frow:last-child .ftrack i{background:var(--mark)}
.exp{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px}
.arm{display:grid;grid-template-columns:70px minmax(0,1fr) 170px;gap:8px;align-items:center}.arm .ftrack{height:12px}.arm.routed .ftrack i{background:var(--mark)}.arm.holdout .ftrack i{background:var(--s2)}
.stack{display:flex;height:16px;border-radius:4px;overflow:hidden;gap:2px}.legend{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--ink2);font-size:12px}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
a{color:var(--accent)}button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:5px 12px}button:hover{background:var(--sel)}
.tl{display:grid}.ev{display:grid;grid-template-columns:76px minmax(0,1fr) auto;gap:2px 12px;padding:9px 0;border-bottom:1px solid var(--line)}
.ev .t{font-family:var(--mono);font-size:11px;color:var(--ink3)}.ev .p{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}.ev .d{grid-column:2/-1;font-size:12px;color:var(--ink2)}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{background:var(--fill);border-radius:999px;padding:3px 10px;font-size:12px}
pre.brief{white-space:pre-wrap;margin:0;font:13px/20px var(--sans);background:var(--fill);border-radius:10px;padding:12px}
.empty{color:var(--ink3);padding:8px 0}
.fact{border:1px solid var(--line);border-radius:10px;padding:12px;display:grid;gap:8px}
.truth{font-size:13px;color:var(--ink2)}.truth b{color:var(--good);font-weight:600}
.claim{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;align-items:start;padding-top:8px;border-top:1px solid var(--line)}
.claim q{grid-column:2;quotes:"\201C" "\201D";font-size:13px;overflow-wrap:anywhere}.claim .small{grid-column:2}
.fix{font-size:12px;color:var(--ink2);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
input,select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:5px 8px;min-width:0;width:100%}
td input,td select{min-width:110px}td.n input{min-width:64px;max-width:80px}
.modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}@media(max-width:700px){.modes{grid-template-columns:1fr}}
.mode{border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;grid-template-columns:auto 1fr;gap:2px 8px;cursor:pointer}
.mode input{width:auto;margin:3px 0 0}.mode .small{grid-column:2}.mode:has(input:checked){border-color:var(--accent);background:var(--markbg)}
.row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}
button.x{padding:3px 9px}.status{font-size:13px}.status.no{color:var(--bad)}.status.ok{color:var(--good)}
</style></head>
<body>
<header><div class="bar"><span class="brand">Wake</span><span class="site" id="site"></span>
<nav><a href="#/" id="nav-o">Overview</a><a href="#/sessions" id="nav-s">Sessions</a><a href="#/config" id="nav-c">Config</a></nav>
<button id="refresh" type="button">Refresh</button></div></header>
<main id="app"><p class="empty">Loading…</p></main>
<script>
const base = location.pathname.replace(/\/$/, '');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const time = (t) => t ? new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const clock = (t) => new Date(t).toLocaleTimeString('en-US', { hour12: false });
async function get(p) { const r = await fetch(base + p, { credentials: 'same-origin' }); if (!r.ok) throw new Error(r.status + ' ' + (await r.text())); return r.json(); }

function overviewView(d) {
  $('#site').textContent = d.site;
  const k = d.kpis, maxF = Math.max(1, d.funnel[0].n);
  const maxI = Math.max(1, ...d.intents.map((i) => i.sessions));
  const segs = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--mark)'];
  const totConv = d.attribution.reduce((a, b) => a + b.conversions, 0);
  return ''
  + '<div class="kpis">'
  + kp('Agent sessions', num(k.sessions), num(k.agentReads) + ' page reads')
  + kp('People took over', num(k.handoffs), k.sessions ? pct(k.handoffs / k.sessions) + ' of sessions' : '')
  + kp('Conversions', num(k.conversions), k.sessions ? pct(k.conversions / k.sessions) + ' of sessions' : '')
  + kp('Value', money(k.value), 'from traced sessions')
  + kp('Guessed URLs', num(d.guessed.length), num(d.guessed.filter((g) => g.rescuedTo).length) + ' redirected to a real page')
  + kp('Crawler requests', num(k.botRequests), 'index and training bots')
  + '</div>'
  + '<div class="grid">'
  + card('Funnel', '<div class="funnel">' + d.funnel.map((f) => '<div class="frow"><span>' + esc(f.step) + '</span><div class="ftrack"><i style="width:' + (f.n / maxF * 100) + '%"></i></div><span class="r">' + num(f.n) + '</span></div>').join('') + '</div>')
  + card('Why agents visit', table(['Intent', 'Sessions', 'Took over', 'Converted'], d.intents.map((i) => [esc(i.label) + '<div class="hbar"><i style="width:' + (i.sessions / maxI * 100) + '%"></i></div>', num(i.sessions), pct(i.sessions ? i.handoffs / i.sessions : 0), pct(i.sessions ? i.conversions / i.sessions : 0)]), [0, 1, 1, 1]))
  + card('Holdout tests', d.experiments.length ? d.experiments.map(expView).join('') : '<p class="empty">No rules configured.</p>', 'wide')
  + card('What agents say vs the truth', answersView(d.answers), 'wide')
  + card('What agents asked', d.questions.length ? table(['Question (personal data removed)', 'Sessions'], d.questions.map((q) => ['<span class="mono">' + esc(q.query) + '</span>', num(q.sessions)]), [0, 1]) : '<p class="empty">No site searches yet.</p>')
  + card('Pages agents expected', d.guessed.length ? table(['Guessed URL', 'Sessions', 'Action'], d.guessed.map((g) => ['<span class="mono">' + esc(g.path) + '</span>', num(g.sessions), g.rescuedTo ? '<span class="pill ok">Sent to ' + esc(g.rescuedTo) + '</span>' : '<span class="pill wait">No match: build it?</span>']), [0, 1, 0]) : '<p class="empty">No 404s from agents.</p>')
  + card('Where analytics would credit these conversions', totConv ? '<div class="stack" role="img" aria-label="Conversion credit by channel">' + d.attribution.map((a, i) => '<i style="width:' + (a.conversions / totConv * 100) + '%;background:' + segs[i % 4] + '"></i>').join('') + '</div><div class="legend">' + d.attribution.map((a, i) => '<span><i style="background:' + segs[i % 4] + '"></i>' + esc(a.label) + ' ' + pct(a.conversions / totConv, 0) + ' · ' + money(a.value) + '</span>').join('') + '</div><p class="small">Based on the referrer when the person opened the agent\'s link. Every one of these started with an agent session.</p>' : '<p class="empty">No conversions yet.</p>')
  + card('Agents', table(['Agent', 'Sessions', 'Took over', 'Converted'], d.agents.map((a) => [esc(a.agent) + ' <span class="small">' + esc(a.vendor || '') + '</span>', num(a.sessions), num(a.handoffs), num(a.conversions)]), [0, 1, 1, 1]))
  + '</div>';
}
function kp(label, v, sub) { return '<div class="kpi"><span class="small">' + label + '</span><b>' + v + '</b><span class="small">' + sub + '</span></div>'; }
function card(title, body, cls) { return '<section class="card ' + (cls || '') + '"><h2>' + title + '</h2>' + body + '</section>'; }
function table(head, rows, right) {
  return '<div class="scroll"><table><thead><tr>' + head.map((h, i) => '<th class="' + (right[i] ? 'r' : '') + '">' + h + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + r.map((c, i) => '<td class="' + (right[i] ? 'r' : '') + '">' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
}
function expVerdict(e) {
  const [a, b] = e.arms || ['Routed', 'Holdout'];
  return !e.handoff.enough ? '<span class="pill wait">Needs 30+ sessions per group</span>'
    : e.handoff.low > 0 ? '<span class="pill ok">' + a + ' wins</span>' : e.handoff.high < 0 ? '<span class="pill no">' + b + ' wins</span>' : '<span class="pill go">No clear difference yet</span>';
}
function expView(e) {
  const m = Math.max(0.0001, e.handoff.routed, e.handoff.holdout);
  const verdict = expVerdict(e);
  const [a, b] = e.arms || ['Routed', 'Holdout'];
  return '<div class="exp"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(e.id) + '</b>' + verdict + '</div>'
    + '<span class="small">' + (e.kind === 'carrier' ? 'Compares: ' + esc(e.label) + ' · half the sessions each'
      : (e.kind === 'brief' ? 'Adds: ' : 'Leads with: ') + esc(e.label) + ' · ' + pct(e.holdoutShare, 0) + ' held out') + '</span>'
    + (e.kind === 'brief' ? '<span class="small">Opened the summary: ' + num(e.routed.opened) + ' of ' + num(e.routed.n) + ' routed sessions (' + pct(e.routed.n ? e.routed.opened / e.routed.n : 0) + ')</span>' : '')
    + arm(a, 'routed', e.routed, e.handoff.routed, e.conversion.routed, m)
    + arm(b, 'holdout', e.holdout, e.handoff.holdout, e.conversion.holdout, m)
    + '<span class="small">' + (e.kind === 'carrier' ? a + ' minus ' + b + ': take-over rate ' : 'Take-over rate difference ') + (e.handoff.diff >= 0 ? '+' : '') + pct(e.handoff.diff) + ' (95% interval ' + pct(e.handoff.low) + ' to ' + pct(e.handoff.high) + '). Conversion difference ' + (e.conversion.diff >= 0 ? '+' : '') + pct(e.conversion.diff) + '.</span></div>';
}
function answersView(a) {
  if (!a) return '<p class="empty">No answer checks yet. Add <span class="mono">answerChecks.facts</span> to the config and run <span class="mono">wake check --config …</span>.</p>';
  const tally = (f) => '<span class="small">' + num(f.correct) + ' correct · ' + num(f.wrong) + ' wrong · ' + num(f.missing) + ' not mentioned</span>';
  const fixView = (f) => {
    if (!f.fixes.length) return '<div class="fix">No page block is linked to this fact. Add <span class="mono">blocks</span> to it to see the rule that fixes it.</div>';
    return f.fixes.map((x) => '<div class="fix">Fix: block <span class="mono">' + esc(x.block) + '</span>'
      + (x.rules.length ? x.rules.map((e) => ' is promoted by rule <b>' + esc(e.id) + '</b> ' + expVerdict(e)
          + ' <span class="small">take-over ' + (e.handoff.diff >= 0 ? '+' : '') + pct(e.handoff.diff) + ' vs holdout, ' + num(e.routed.n) + ' routed / ' + num(e.holdout.n) + ' held out</span>').join(' ·')
        : ' <span class="pill wait">No rule promotes it yet: add one</span>') + '</div>').join('');
  };
  const wrong = a.facts.filter((f) => f.wrong);
  return '<span class="small">Last run ' + time(a.finishedAt) + ' · ' + num(a.questions) + ' questions asked of ' + esc(a.engines.join(', ')) + ' · ' + num(a.answers) + ' answers'
    + (a.errors.length ? ' · <span class="no">' + num(a.errors.length) + ' failed</span>' : '') + '</span>'
    + (wrong.length ? wrong.map((f) => '<div class="fact"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(f.claim) + '</b><span class="pill no">' + num(f.wrong) + ' wrong</span></div>'
        + '<div class="truth"><b>Truth:</b> ' + esc(f.truth) + '</div>' + fixView(f)
        + f.claims.map((c) => '<div class="claim"><span class="pill no">' + esc(c.engine) + '</span><q>' + esc(c.quote || '(no quote)') + '</q><span class="small">Asked: <span class="mono">' + esc(c.question) + '</span></span></div>').join('')
        + tally(f) + '</div>').join('')
      : '<p class="empty">No wrong claims in the last run.</p>')
    + table(['Fact', 'Correct', 'Wrong', 'Not mentioned'], a.facts.map((f) => [esc(f.claim) + ' <span class="small mono">' + esc(f.id) + '</span>', num(f.correct), f.wrong ? '<span class="no">' + num(f.wrong) + '</span>' : '0', num(f.missing)]), [0, 1, 1, 1])
    + (a.errors.length ? '<span class="small">Failed: ' + a.errors.slice(0, 5).map((e) => esc(e.engine) + ' · ' + esc(e.question) + ': ' + esc(e.error)).join('; ') + '</span>' : '');
}
function arm(label, cls, a, h, c, m) {
  return '<div class="arm ' + cls + '"><span class="small">' + label + '</span><div class="ftrack"><i style="width:' + (h / m * 100) + '%"></i></div><span class="small r">' + pct(h) + ' took over · ' + num(a.n) + '</span></div>';
}

function sessionsView(list) {
  if (!list.length) return '<p class="empty">No agent sessions yet. Fetch any page through Wake with an agent user-agent such as ChatGPT-User.</p>';
  return card('Recent sessions', table(['Session', 'Agent', 'Reads', 'Top intent', 'Status', 'Last seen'], list.map((s) => [
    '<a class="mono" href="#/s/' + esc(s.code) + '">' + esc(s.code) + '</a>', esc(s.agent), num(s.reads), esc(s.topIntent || '–'),
    s.convertedAt ? '<span class="pill ok">Converted ' + (s.value ? money(s.value) : '') + '</span>' : s.handoffAt ? '<span class="pill go">Person took over</span>' : '<span class="pill wait">Agent only</span>',
    time(s.lastSeen)]), [0, 0, 1, 0, 0, 0]));
}

const TYPE = { fetch: 'Read', rescue: 'Guessed URL, redirected', not_found: 'Guessed URL, not found', handoff: 'Person took over', shared: 'Person opened a shared session link', link_check: 'Agent checked its sign-up link', conversion: 'Converted', bot: 'Crawler', brief: 'Read its research summary' };
function sessionView(d) {
  const s = d.session;
  const evs = d.events.map((e) => {
    let detail = TYPE[e.type] || e.type;
    if (e.title) detail += ' · ' + esc(e.title);
    if (e.query) detail += ' · asked "' + esc(e.query) + '"';
    if (e.data?.to) detail += ' → ' + esc(e.data.to);
    if (e.data?.rules) detail += ' · rules: ' + esc(e.data.rules.join(', '));
    if (e.data?.facts) detail += ' · ' + e.data.facts.length + ' facts: ' + esc(e.data.facts.join(', '));
    if (e.data?.name) detail += ' · ' + esc(e.data.name) + (e.data.value ? ' ' + money(e.data.value) : '');
    if (e.data?.referer !== undefined) detail += ' · referrer: ' + esc(e.data.referer || 'none');
    const st = e.status ? '<span class="pill ' + (e.status < 300 ? 'ok' : e.status < 400 ? 'go' : 'wait') + '">' + e.status + '</span>' : '';
    return '<div class="ev"><span class="t">' + clock(e.ts) + '</span><span class="p">' + esc(e.method || '') + ' ' + esc(e.path || '') + ' <span class="small">' + esc(e.actor || '') + '</span></span>' + st + '<span class="d">' + detail + '</span></div>';
  }).join('');
  return '<p><a href="#/sessions">All sessions</a></p><div class="grid">'
    + card('Session <span class="mono">' + esc(s.code) + '</span>', '<span class="small">' + esc(s.agent) + ' · started ' + time(s.created_at) + ' · ' + esc(s.origin) + '</span><div class="tl">' + evs + '</div>', 'wide')
    + card('Intent', s.intents.length ? '<div class="chips">' + s.intents.map((i) => '<span class="chip">' + esc(i.label) + ' · ' + Math.round(i.confidence * 100) + '%</span>').join('') + '</div>' : '<p class="empty">Not enough reads yet.</p>')
    + card('Brief for the next conversation', '<pre class="brief">' + esc(d.brief.text) + '</pre>')
    + '</div>';
}


// Config editor: mode, intents, blocks and rules. Each save is a new version; SDKs pick it up on their next refresh.
let cfgState = null;
const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const joined = (v) => (Array.isArray(v) ? v : v ? [v] : []).join(', ');
const MODES = [['shadow', 'Observe', 'Changes nothing. Reports sessions and which rules would have fired.'],
  ['trace', 'Trace', 'Sessions, link rewriting and hand-offs. No content rules.'], ['route', 'Route', 'Everything: rules lead with blocks, with holdouts.']];
const LABELS = { id: 'ID', label: 'Label', paths: 'Paths', keywords: 'Keywords', pitch: 'Pitch', summary: 'Summary', all: 'All of these intents', any: 'Or any of', path: 'Paths', holdout: 'Holdout %' };
const inp = (name, value, attrs) => '<input name="' + name + '" aria-label="' + LABELS[name] + '" value="' + esc(value) + '" ' + (attrs || '') + '>';
const del = '<button type="button" class="x" data-del aria-label="Remove">×</button>';

function collectConfig() {
  const app = $('#app');
  const rows = (sel) => [...app.querySelectorAll(sel + ' tbody tr')];
  const val = (tr, n) => tr.querySelector('[name="' + n + '"]').value.trim();
  const intents = rows('#intents').map((tr) => {
    const i = { ...(cfgState.intents[tr.dataset.i] || {}), id: val(tr, 'id'), label: val(tr, 'label'), paths: csv(val(tr, 'paths')), keywords: csv(val(tr, 'keywords')) };
    if (val(tr, 'pitch')) i.pitch = val(tr, 'pitch'); else delete i.pitch;
    return i;
  });
  const blocks = {};
  for (const tr of rows('#blocks')) if (val(tr, 'id')) blocks[val(tr, 'id')] = val(tr, 'summary');
  const rules = rows('#rules').map((tr) => {
    const old = cfgState.rules[tr.dataset.i] || {};
    const when = { ...(old.when || {}) };
    for (const [k, n] of [['intents', 'all'], ['anyIntents', 'any'], ['path', 'path']]) { const v = csv(val(tr, n)); if (v.length) when[k] = v; else delete when[k]; }
    const pct = val(tr, 'holdout');
    return { ...old, id: val(tr, 'id'), when, promote: tr.querySelector('[name="promote"]').value, holdout: pct === '' ? 0.2 : Number(pct) / 100 };
  });
  const mode = (app.querySelector('input[name="mode"]:checked') || {}).value || cfgState.mode;
  return { mode, intents, blocks, rules };
}

function renderConfig(status) {
  const c = cfgState;
  $('#site').textContent = c.site.name;
  const blockIds = Object.keys(c.blocks);
  const promoteSelect = (cur) => '<select name="promote" aria-label="Leads with block">' + [...new Set([...blockIds, ...(cur ? [cur] : [])])].map((b) =>
    '<option value="' + esc(b) + '"' + (b === cur ? ' selected' : '') + '>' + esc(b) + (blockIds.includes(b) ? '' : ' (not a block)') + '</option>').join('') + '</select>';
  const tbl = (id, head, rows, add) => '<div class="scroll"><table id="' + id + '"><thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '<th></th></tr></thead><tbody>'
    + rows.join('') + '</tbody></table></div><div class="row-actions"><button type="button" data-add="' + id + '">' + add + '</button></div>';
  $('#app').innerHTML = '<div class="grid">'
    + card('Config <span class="small">version ' + c.version + (c.savedAt ? ' · saved ' + time(c.savedAt) + (c.source ? ' from ' + esc(c.source) : '') : '') + '</span>',
      '<div class="modes" role="radiogroup" aria-label="Mode">' + MODES.map(([v, label, text]) => '<label class="mode"><input type="radio" name="mode" value="' + v + '"' + (c.mode === v ? ' checked' : '') + '><b>' + label + ' <span class="small mono">' + v + '</span></b><span class="small">' + text + '</span></label>').join('') + '</div>', 'wide')
    + card('Intents', tbl('intents', ['ID', 'Label', 'Paths', 'Keywords', 'Pitch'], c.intents.map((i, n) => '<tr data-i="' + n + '"><td>' + inp('id', i.id) + '</td><td>' + inp('label', i.label) + '</td><td>' + inp('paths', joined(i.paths), 'placeholder="/plans/**"') + '</td><td>' + inp('keywords', joined(i.keywords)) + '</td><td>' + inp('pitch', i.pitch) + '</td><td>' + del + '</td></tr>'), 'Add intent'), 'wide')
    + card('Blocks', tbl('blocks', ['ID (as in &lt;!-- wake:block id --&gt;)', 'Summary'], Object.entries(c.blocks).map(([id, text]) => '<tr><td>' + inp('id', id) + '</td><td>' + inp('summary', text) + '</td><td>' + del + '</td></tr>'), 'Add block'), 'wide')
    + card('Rules', tbl('rules', ['ID', 'All of these intents', 'Or any of', 'Paths', 'Leads with block', 'Holdout %'], c.rules.map((r, n) => '<tr data-i="' + n + '"><td>' + inp('id', r.id) + '</td><td>' + inp('all', joined(r.when?.intents)) + '</td><td>' + inp('any', joined(r.when?.anyIntents)) + '</td><td>' + inp('path', joined(r.when?.path)) + '</td><td>' + promoteSelect(r.promote) + '</td><td class="n">' + inp('holdout', Math.round((r.holdout ?? 0.2) * 1000) / 10, 'type="number" min="0" max="100" step="1"') + '</td><td>' + del + '</td></tr>'), 'Add rule')
      + '<span class="small">Holdout: the share of matching sessions that keep the page as it is, so the dashboard can compare them with routed sessions.</span>', 'wide')
    + card('Save', '<div class="row-actions"><button type="button" class="primary" id="save">Save as version ' + (c.version + 1) + '</button><span class="status ' + (status?.cls || '') + '" role="status">' + esc(status?.text || 'SDKs pick up a new version on their next config refresh (about once a minute).') + '</span></div>'
      + (c.history.length ? table(['Version', 'Saved', 'From'], c.history.map((h) => [String(h.version), time(h.created_at), esc(h.source || '')]), [0, 0, 0]) : ''), 'wide')
    + '</div>';
}

async function configRoute() {
  cfgState = await get('/api/config');
  renderConfig();
}

$('#app').addEventListener('click', async (e) => {
  if (!cfgState || !location.hash.startsWith('#/config')) return;
  const add = e.target.closest('[data-add]'), rm = e.target.closest('[data-del]');
  if (add || rm) {
    const edited = collectConfig();
    cfgState = { ...cfgState, ...edited };
    if (rm) {
      const tr = rm.closest('tr'), table = tr.closest('table').id, index = [...tr.parentNode.children].indexOf(tr);
      if (table === 'blocks') delete cfgState.blocks[Object.keys(cfgState.blocks)[index]];
      else cfgState[table] = cfgState[table].filter((_, n) => n !== index);
    }
    if (add?.dataset.add === 'intents') cfgState.intents = [...cfgState.intents, { id: '', label: '', paths: [], keywords: [] }];
    if (add?.dataset.add === 'blocks') cfgState.blocks = { ...cfgState.blocks, ['block-' + (Object.keys(cfgState.blocks).length + 1)]: '' };
    if (add?.dataset.add === 'rules') cfgState.rules = [...cfgState.rules, { id: '', when: {}, promote: Object.keys(cfgState.blocks)[0] || '', holdout: 0.2 }];
    renderConfig();
    return;
  }
  if (e.target.id !== 'save') return;
  const edited = collectConfig();
  const bad = edited.rules.find((r) => !(r.holdout >= 0 && r.holdout <= 1));
  if (bad) {
    cfgState = { ...cfgState, ...edited };
    return renderConfig({ cls: 'no', text: 'Rule "' + bad.id + '": holdout must be between 0 and 100%.' });
  }
  e.target.disabled = true;
  try {
    const r = await fetch(base + '/api/config', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: cfgState.version, ...edited }) });
    const body = await r.json();
    if (!r.ok) { cfgState = { ...cfgState, ...edited }; return renderConfig({ cls: 'no', text: body.error || ('Could not save (' + r.status + ')') }); }
    cfgState = await get('/api/config');
    renderConfig({ cls: 'ok', text: 'Saved version ' + body.version + '. SDKs pick it up on their next config refresh.' });
  } catch (err) { e.target.disabled = false; renderConfig({ cls: 'no', text: err.message }); }
});

async function route() {
  const h = location.hash || '#/';
  $('#nav-o').className = h === '#/' ? 'on' : ''; $('#nav-s').className = h.startsWith('#/s') ? 'on' : ''; $('#nav-c').className = h === '#/config' ? 'on' : '';
  try {
    if (h === '#/config') await configRoute();
    else if (h.startsWith('#/s/')) $('#app').innerHTML = sessionView(await get('/api/sessions/' + h.slice(4)));
    else if (h === '#/sessions') $('#app').innerHTML = sessionsView(await get('/api/sessions'));
    else $('#app').innerHTML = overviewView(await get('/api/overview'));
  } catch (e) { $('#app').innerHTML = '<p class="empty">Could not load: ' + esc(e.message) + '</p>'; }
}
addEventListener('hashchange', route); $('#refresh').addEventListener('click', route); route();
</script></body></html>`;
