// Session state travels in the URL, so the SDK never needs a database at request time.
//   /a/MW-7K2Q9P.30a1/plans/family
//      ^ code      ^ one base-36 digit per configured intent (score 0–35), trailing zeros dropped
// Every link Wake rewrites carries the updated state, so the next read knows what the session did so far.

export function encodeState(scores) {
  return scores.map((n) => Math.max(0, Math.min(35, Math.round(n || 0))).toString(36)).join('').replace(/0+$/, '');
}

export function decodeState(state, count) {
  const out = new Array(count).fill(0);
  for (let i = 0; i < Math.min(count, (state || '').length); i++) {
    const v = parseInt(state[i], 36);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

export function formatToken(code, scores) {
  const s = encodeState(scores);
  return s ? `${code}.${s}` : code;
}
