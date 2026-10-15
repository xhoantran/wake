import { matchPath } from './util.js';

function words(text) {
  return ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

/**
 * Score each configured intent against what a session has done so far.
 * A matching path is worth 2 points; each keyword found in a search query or
 * in the path's words is worth 1 point per event.
 * intents: [{ id, label, paths?: string[], keywords?: string[] }]
 * events:  [{ path, query? }]
 */
export function scoreIntents(events, intents = []) {
  const out = [];
  for (const intent of intents) {
    let score = 0;
    for (const ev of events) {
      if (!ev.path) continue;
      if (matchPath(intent.paths, ev.path)) score += 2;
      const text = words((ev.query || '') + ' ' + ev.path);
      for (const kw of intent.keywords || []) {
        if (text.includes(' ' + kw.toLowerCase() + ' ')) score += 1;
      }
    }
    if (score > 0) out.push({ id: intent.id, label: intent.label || intent.id, score, confidence: Math.min(1, score / 4) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** True when the session's intents satisfy a rule's `when` clause. */
export function intentsSatisfy(when = {}, scored, minScore = 2) {
  const strong = new Set(scored.filter((s) => s.score >= minScore).map((s) => s.id));
  if (when.intents && !when.intents.every((id) => strong.has(id))) return false;
  if (when.anyIntents && !when.anyIntents.some((id) => strong.has(id))) return false;
  return true;
}
