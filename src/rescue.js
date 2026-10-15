const NOISE = new Set(['html', 'htm', 'php', 'aspx', 'index', 'www']);

function tokens(path) {
  return path.toLowerCase().split(/[/\-_.]+/).filter((t) => t && !NOISE.has(t));
}

/**
 * Find the best existing page for a URL an agent guessed.
 * candidates: paths known to exist. aliases: exact { from: to } overrides.
 * synonyms: { token: [related tokens] } to bridge vocabulary ("roaming" ~ "travel").
 * Returns { to, score } or null when nothing is close enough.
 */
export function suggestPath(path, candidates, { aliases = {}, synonyms = {}, threshold = 0.34 } = {}) {
  const clean = path.replace(/\/+$/, '') || '/';
  if (aliases[clean]) return { to: aliases[clean], score: 1 };
  const orig = tokens(clean);
  if (!orig.length) return null;
  const expanded = new Set(orig);
  for (const t of orig) for (const s of synonyms[t] || []) expanded.add(s.toLowerCase());
  let best = null;
  for (const cand of new Set(candidates)) {
    if (cand === clean) continue;
    const ct = tokens(cand);
    if (!ct.length) continue;
    const overlap = ct.filter((t) => expanded.has(t)).length;
    if (!overlap) continue;
    let score = overlap / Math.max(ct.length, orig.length);
    if (ct[0] === orig[0]) score += 0.1;
    if (!best || score > best.score || (score === best.score && cand.length < best.to.length)) best = { to: cand, score };
  }
  return best && best.score >= threshold ? { to: best.to, score: Math.round(best.score * 100) / 100 } : null;
}

/** Pull <loc> paths out of a sitemap. */
export function parseSitemap(xml) {
  const out = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try { out.push(new URL(m[1]).pathname); } catch { if (m[1].startsWith('/')) out.push(m[1]); }
  }
  return out;
}
