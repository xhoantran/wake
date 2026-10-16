// The per-session research brief: a page under the session URL that answers what the agent has been
// researching, built only from the site's own fact list. No model writes it, so it can't invent anything:
// every statement is a configured fact, and every fact links to the page it comes from.
//   /a/MW-7K2Q9P.30a1/research-brief
// Sessions in the routed arm get a plain link to it at the top of each page; held-out sessions don't.
import { intentsSatisfy } from '../intent.js';

export const BRIEF_RULE = 'research-brief';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mdEsc = (s) => String(s ?? '').replace(/([\\[\]])/g, '\\$1');

/** Intents a fact answers: its own `intents`, else those of the rules that promote one of its blocks. */
function factIntents(cfg, fact) {
  if (fact.intents?.length) return fact.intents;
  const ids = new Set();
  for (const r of cfg.rules) {
    if (!(fact.blocks || []).includes(r.promote)) continue;
    for (const id of [...(r.when?.intents || []), ...(r.when?.anyIntents || [])]) ids.add(id);
  }
  return [...ids];
}

/**
 * Pick the facts for a session, grouped under the intent they answer, strongest intent first.
 * scored: [{ id, label, score }] from the URL token. With no strong intent yet, returns every fact
 * under one general heading, so the page is still useful.
 */
export function selectFacts(cfg, scored) {
  const strong = scored.filter((s) => s.score >= cfg.minIntentScore).sort((a, b) => b.score - a.score);
  const facts = cfg.siteFacts;
  const max = cfg.brief.maxFacts;
  if (!strong.length) return { strong, groups: facts.length ? [{ intent: null, facts: facts.slice(0, max) }] : [] };
  const used = new Set();
  const groups = [];
  let count = 0;
  for (const intent of strong) {
    const list = facts.filter((f) => !used.has(f.id) && factIntents(cfg, f).includes(intent.id));
    const take = list.slice(0, Math.max(0, max - count));
    if (!take.length) continue;
    take.forEach((f) => used.add(f.id));
    count += take.length;
    groups.push({ intent, facts: take });
  }
  return { strong, groups };
}

/** Whether a page for this session should carry the brief link at all. */
export function briefEligible(cfg, scored) {
  if (!cfg.brief.enabled || !cfg.siteFacts.length) return false;
  const { strong, groups } = selectFacts(cfg, scored);
  return strong.length > 0 && groups.length > 0 && intentsSatisfy(cfg.brief.when, scored, cfg.minIntentScore);
}

/** The link added near the top of a routed session's pages. Plain navigation, never an instruction to the agent. */
export function briefLink(cfg, scored, kind) {
  const { strong } = selectFacts(cfg, scored);
  const topics = strong.slice(0, 3).map((s) => s.label);
  const text = `${cfg.brief.linkText}: ${topics.join(', ')} (with sources)`;
  return kind === 'html'
    ? `<p class="wake-brief"><a href="${esc(cfg.brief.path)}">${esc(text)}</a></p>`
    : `[${mdEsc(text)}](${cfg.brief.path})\n`;
}

/** Render the brief. Links are written as clean site paths; the caller rewrites them to carry the session. */
export function renderBrief(cfg, scored, { kind = 'html', site = '' } = {}) {
  const { strong, groups } = selectFacts(cfg, scored);
  const b = cfg.brief;
  const lead = strong.length
    ? `Facts from ${site || 'this site'} that match what this visit has looked at: ${strong.map((s) => s.label).join(', ')}.`
    : `Key facts from ${site || 'this site'}.`;
  const factCount = groups.reduce((n, g) => n + g.facts.length, 0);

  if (kind === 'markdown') {
    const lines = [`# ${b.title}`, '', lead, ''];
    for (const g of groups) {
      if (g.intent) lines.push(`## ${g.intent.label}`, '');
      for (const f of g.facts) lines.push(`- **${mdEsc(f.claim || f.id)}.** ${mdEsc(f.truth)}${f.source ? ` [Source](${f.source})` : ''}`);
      lines.push('');
    }
    if (!factCount) lines.push('No facts are published for these topics yet.', '');
    if (b.ctaPath) lines.push(`${b.ctaText}: [${b.ctaPath}](${b.ctaPath})`, '');
    lines.push(`Every statement above is copied from ${site || 'this site'}'s own pages, which are linked.`);
    return lines.join('\n') + '\n';
  }

  const sections = groups.map((g) => (g.intent ? `<section>\n<h2>${esc(g.intent.label)}</h2>\n` : '<section>\n')
    + '<ul>\n' + g.facts.map((f) => `<li><strong>${esc(f.claim || f.id)}.</strong> ${esc(f.truth)}${f.source ? ` <a href="${esc(f.source)}">Source</a>` : ''}</li>`).join('\n') + '\n</ul>\n</section>').join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(b.title)}${site ? ' | ' + esc(site) : ''}</title>
<meta name="robots" content="noindex, nofollow"></head>
<body><main>
<h1>${esc(b.title)}</h1>
<p>${esc(lead)}</p>
${sections || '<p>No facts are published for these topics yet.</p>'}
${b.ctaPath ? `<p>${esc(b.ctaText)}: <a href="${esc(b.ctaPath)}">${esc(b.ctaPath)}</a></p>` : ''}
<p><small>Every statement above is copied from ${esc(site || 'this site')}'s own pages, which are linked.</small></p>
</main></body></html>
`;
}

/**
 * Check facts against their source pages: every number in a fact's truth (prices, amounts, counts)
 * must appear on the source page. Catches facts that went stale when a page changed.
 * fetchPage(path) => Promise<string | null>
 */
export async function checkFacts(cfg, fetchPage) {
  const results = [];
  const norm = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/,(?=\d{3}\b)/g, '').toLowerCase();
  for (const f of cfg.siteFacts) {
    if (!f.source) { results.push({ id: f.id, ok: false, problem: 'no source page' }); continue; }
    let page = null;
    try { page = await fetchPage(f.source); } catch { /* reported below */ }
    if (page == null) { results.push({ id: f.id, ok: false, problem: `could not load ${f.source}` }); continue; }
    const text = norm(page);
    const numbers = [...new Set(norm(f.truth).match(/\$?\d+(?:\.\d+)?(?:\s?(?:%|gb|mb|tb))?/g) || [])];
    const missing = numbers.filter((n) => !text.includes(n));
    results.push(missing.length ? { id: f.id, ok: false, problem: `not on ${f.source}: ${missing.join(', ')}` } : { id: f.id, ok: true });
  }
  return results;
}
