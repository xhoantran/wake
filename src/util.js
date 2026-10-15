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
  const token = slash === -1 ? after : after.slice(0, slash);
  const dot = token.indexOf('.');
  const code = dot === -1 ? token : token.slice(0, dot);
  const state = dot === -1 ? '' : token.slice(dot + 1);
  if (!CODE_RE.test(code) || !/^[0-9a-z]{0,64}$/.test(state)) return null;
  const rest = slash === -1 ? '/' : after.slice(slash);
  return { code, state, token, rest };
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
