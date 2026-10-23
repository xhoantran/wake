const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

export function mintCode(codePrefix, length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${codePrefix}-${s}`;
}

export const CODE_RE = /^[A-Z0-9]{1,10}-[A-Z0-9]{4,16}$/;

/**
 * Split "/a/WK-7K2Q9P.3a/plans/family" into
 * { code: "WK-7K2Q9P", state: "3a", token: "WK-7K2Q9P.3a", rest: "/plans/family" } for prefix "/a".
 * The state after the dot is optional (see src/sdk/token.js).
 */
export function parsePrefixed(pathname, prefix) {
  if (!pathname.startsWith(prefix + '/')) return null;
  const after = pathname.slice(prefix.length + 1);
  const slash = after.indexOf('/');
  const parsed = parseToken(slash === -1 ? after : after.slice(0, slash));
  return parsed && { ...parsed, rest: slash === -1 ? '/' : after.slice(slash) };
}

/** Split a session token "WK-7K2Q9P.3a" into { code, state, token }, or null when it is not one. */
export function parseToken(token) {
  if (!token) return null;
  const dot = token.indexOf('.');
  const code = dot === -1 ? token : token.slice(0, dot);
  const state = dot === -1 ? '' : token.slice(dot + 1);
  if (!CODE_RE.test(code) || !/^[0-9a-z]{0,64}$/.test(state)) return null;
  return { code, state, token };
}

const paramName = (part) => { try { return decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')); } catch { return part.split('=')[0]; } };

/** The first value of a query parameter, read from a raw "?a=1&b=2" string. */
export function getParam(search, name) {
  for (const part of (search || '').replace(/^\?/, '').split('&')) {
    if (part && paramName(part) === name) {
      if (!part.includes('=')) return '';
      const v = part.slice(part.indexOf('=') + 1);
      try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
    }
  }
  return null;
}

/** Remove parameters from a raw "?a=1&b=2" string. The others keep their exact spelling and order. */
export function stripParams(search, names) {
  const parts = (search || '').replace(/^\?/, '').split('&').filter((p) => p && !names.includes(paramName(p)));
  return parts.length ? '?' + parts.join('&') : '';
}

/** Set one parameter (replacing any earlier value) at the end of a raw "?a=1" string. value must be URL-safe. */
export function setParam(search, name, value) {
  const rest = stripParams(search, [name]);
  return (rest ? rest + '&' : '?') + `${name}=${value}`;
}

/**
 * Find the session code a URL carries, in either form:
 *   path   /a/WK-7K2Q9P.3a/plans    (cfg.prefix; cfg.handoffPrefix for hand-offs)
 *   query  /plans?wk=WK-7K2Q9P.3a   (cfg.param;  cfg.handoffParam for hand-offs)
 * Both forms are always read, so links keep working when a site switches carrier.
 * Returns { ho, pre, cleanPath, cleanSearch }: ho / pre are { code, state, token, rest, via } or null,
 * and cleanSearch is the query without Wake's parameters.
 */
export function readSession(url, cfg) {
  const cleanSearch = stripParams(url.search, [cfg.param, cfg.handoffParam]);
  let ho = parsePrefixed(url.pathname, cfg.handoffPrefix);
  let pre = ho ? null : parsePrefixed(url.pathname, cfg.prefix);
  if (ho) ho.via = 'path';
  else if (pre) pre.via = 'path';
  else {
    const h = parseToken(getParam(url.search, cfg.handoffParam));
    const p = h ? null : parseToken(getParam(url.search, cfg.param));
    if (h) ho = { ...h, rest: url.pathname, via: 'query' };
    if (p) pre = { ...p, rest: url.pathname, via: 'query' };
  }
  return { ho, pre, cleanPath: (ho || pre)?.rest ?? url.pathname, cleanSearch };
}

/** Glob for URL paths: "*" matches within one segment, "**" matches anything. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '/?$');
}

export function matchPath(globs, path) {
  if (!globs) return false;
  const list = Array.isArray(globs) ? globs : [globs];
  return list.some((g) => globToRegExp(g).test(path));
}

/** FNV-1a hash of a string mapped to [0, 1). Used for stable holdout assignment. */
export function unitHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Remove personal data from free text before it is stored. */
export function redact(text) {
  if (!text) return text;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{1,6}\s+(?:[a-z0-9.]+\s+){0,3}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway)\b\.?/gi, '[address]')
    .replace(/\+?\(?\d[\d\s().-]{5,}\d/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '[number]' : m));
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) },
  });
}

/** Short non-reversible-by-us hash for IPs (salted FNV-1a, hex). Used only to group shadow-mode reads. */
export function hashIp(ip, salt = '') {
  if (!ip) return null;
  return Math.floor(unitHash(salt + '|' + ip) * 0xffffffff).toString(16).padStart(8, '0');
}
