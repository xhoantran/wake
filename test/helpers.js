// Agents follow the links Wake gives them; tests do the same, so session state carries over.
export function tokenFrom(text, code) {
  const m = (text || '').match(new RegExp(`/a/(${code}(?:\\.[0-9a-z]+)?)(?=/)`));
  return m ? m[1] : null;
}

/** Read paths in order as one agent session, following the session token each response hands out. */
export async function walk(get, code, paths, opts) {
  let token = code;
  const responses = [];
  for (const p of paths) {
    const r = await get(`/a/${token}${p}`, opts);
    const loc = r.headers.get('location');
    const body = loc ? '' : await r.text();
    token = tokenFrom(loc || body, code) || token;
    responses.push({ r, body, loc });
  }
  return { token, responses };
}
