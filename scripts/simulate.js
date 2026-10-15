// Send simulated agent sessions through a running Wake (started with --trust-proxy) to fill the dashboard.
// The people's choices are random draws, so the experiment results only show that the plumbing works.
// Usage: node scripts/simulate.js [http://127.0.0.1:8787] [sessions]
const W = process.argv[2] || 'http://127.0.0.1:8787';
const N = Number(process.argv[3] || 400);

const AGENTS = [
  [0.55, 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot'],
  [0.2, 'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)'],
  [0.2, 'Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)'],
  [0.05, 'Mozilla/5.0 (compatible; MistralAI-User/1.0; +https://docs.mistral.ai/robots)'],
];
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Version/19.0 Mobile Safari/604.1';
const REFERERS = [[0.6, ''], [0.15, 'https://chatgpt.com/'], [0.15, 'https://www.google.com/'], [0.1, 'https://perplexity.ai/']];

// Each persona: the pages its agent reads, and how likely a person takes over / orders.
// `lift` is added to the take-over chance when a routed rule fired, so the holdout test has something to find.
const PERSONAS = [
  { w: 0.3, steps: ['/plans/family', '/search?q=family plan 4 lines mexico travel', '/plans/international-roaming', '/travel/international-pass', '/agents.md'], take: 0.18, lift: 0.1, order: 0.5 },
  { w: 0.2, steps: ['/search?q=switch from crestline keep number', '/compare/crestline', '/deals/bring-your-own-phone', '/pricing'], take: 0.15, lift: 0.06, order: 0.45 },
  { w: 0.2, steps: ['/deals/bring-your-own-phone', '/search?q=trade in iphone 13 value', '/deals/trade-in'], take: 0.07, lift: 0, order: 0.3 },
  { w: 0.15, steps: ['/', '/plans/family', '/pricing', '/compare/crestline'], take: 0.1, lift: 0, order: 0.35 },
  { w: 0.1, steps: ['/cancel', '/support/cancel', '/plans/loyalty'], take: 0, lift: 0, order: 0 },
  { w: 0.05, steps: ['/search?q=home internet at 1200 Main Street', '/coverage-map.json'], take: 0.02, lift: 0, order: 0 },
];

const pick = (list) => { let r = Math.random(), acc = 0; for (const item of list) { acc += item[0] ?? item.w; if (r <= acc) return item; } return list[list.length - 1]; };
const ip = () => `20.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 250)}`;

async function req(path, { ua, from, headers = {}, method = 'GET', body } = {}) {
  const r = await fetch(W + path, { method, body, redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': from, ...headers } });
  r.text_ = await r.text();
  return r;
}

// Agents follow the links Wake hands out, which carry the session token (code plus state).
const tokenIn = (r, code) => ((r.headers.get('location') || r.text_).match(new RegExp(`/a/(${code}(?:\\.[0-9a-z]+)?)(?=/)`)) || [])[1];

async function session() {
  const p = pick(PERSONAS);
  const ua = pick(AGENTS)[1];
  const agentIp = ip();
  let code = null, token = null, routed = false;
  for (const step of p.steps) {
    let path = token ? `/a/${token}${step}` : step;
    let r = await req(path.replace(/ /g, '+'), { ua, from: agentIp });
    code = code || r.headers.get('x-wake-session');
    if (code) token = tokenIn(r, code) || token || code;
    if (r.status === 308) { r = await req(r.headers.get('location'), { ua, from: agentIp }); token = tokenIn(r, code) || token; }
    const rules = r.headers.get('x-wake-rules') || '';
    if (rules && !rules.includes('holdout')) routed = true;
  }
  if (!code || Math.random() > p.take + (routed ? p.lift : 0)) return;
  if (Math.random() < 0.5) await req(`/r/${token}/signup`, { ua, from: agentIp }); // agent checks its link first
  const person = ip().replace(/^20\./, '73.');
  const r = await req(`/r/${token}/signup`, { ua: SAFARI, from: person, headers: { referer: pick(REFERERS)[1] } });
  const cookie = (r.headers.getSetCookie()[0] || '').split(';')[0];
  await req('/signup', { ua: SAFARI, from: person, headers: { cookie } });
  if (Math.random() < p.order) await req('/checkout/order', { ua: SAFARI, from: person, headers: { cookie }, method: 'POST', body: 'plan=unlimited-plus' });
}

async function crawlers() {
  for (const ua of ['Mozilla/5.0 (compatible; GPTBot/1.2)', 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
    for (const path of ['/', '/plans/family', '/travel/international-pass', '/compare/crestline', '/support/cancel']) await req(path, { ua, from: ip() });
  }
}

const started = Date.now();
await crawlers();
let done = 0;
const queue = Array.from({ length: N }, () => session);
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) { await queue.shift()(); done++; } }));
console.log(`Sent ${done} simulated agent sessions to ${W} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
