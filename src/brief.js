import { matchPath } from './util.js';

/** Summarize one session for whoever talks to the person next (sales, a store, onboarding). */
export function buildBrief(session, events, config) {
  const reads = events.filter((e) => e.type === 'fetch' && e.actor === 'agent');
  const seen = new Map();
  for (const e of reads) {
    if (seen.has(e.path) || matchPath(config.search.paths, e.path)) continue;
    // "Family plans | Meridian Wireless" -> "Family plans"
    const title = (e.title || e.path).split(/\s+[|·–—-]\s+/)[0];
    if ([...seen.values()].some((p) => p.title === title)) continue;
    seen.set(e.path, { path: e.path, title });
  }
  const pages = [...seen.values()];
  const questions = [...new Set(reads.map((e) => e.query).filter(Boolean))];
  const strong = (session.intents || []).filter((i) => i.score >= config.minIntentScore);
  const byId = new Map(config.intents.map((i) => [i.id, i]));

  const routed = new Set();
  for (const e of reads) for (const r of e.data?.rules || []) if (!r.endsWith('(holdout)')) routed.add(r);
  const ruleBlocks = config.rules.filter((r) => routed.has(r.id)).map((r) => config.blocks[r.promote]).filter(Boolean);
  const pitches = strong.map((i) => byId.get(i.id)?.pitch).filter(Boolean);
  const leadWith = [...new Set([...ruleBlocks, ...pitches])];

  const guessed = events.filter((e) => e.type === 'rescue' || e.type === 'not_found').map((e) => e.path);
  const minutesToHandoff = session.handoff_at ? Math.round((session.handoff_at - session.created_at) / 60000) : null;

  const lines = [
    `Session ${session.code} · ${session.agent || 'Unknown agent'}`,
    pages.length ? `Their agent read: ${pages.map((p) => p.title).join('; ')}` : 'Their agent read nothing yet.',
  ];
  if (questions.length) lines.push(`They asked: ${questions.map((q) => `"${q}"`).join(', ')}`);
  if (strong.length) lines.push(`Likely needs: ${strong.map((i) => i.label).join(', ')}`);
  if (leadWith.length) lines.push(`Lead with: ${leadWith.join(' ')}`);
  if (guessed.length) lines.push(`Looked for pages that don't exist: ${guessed.join(', ')}`);
  if (minutesToHandoff != null) lines.push(`A person opened the agent's link ${minutesToHandoff} min after the agent's first read.`);

  return { code: session.code, pages, questions, intents: strong, leadWith, guessed, minutesToHandoff, text: lines.join('\n') };
}
