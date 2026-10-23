import { matchPath, getParam, setParam } from './util.js';

const ASSET_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|zip|gz)$/i;
const SKIP_SCHEME = /^(#|mailto:|tel:|sms:|javascript:|data:|blob:)/i;

/**
 * Where a link goes once it carries a session token.
 *   path:  /a/{token}/page?x=1     (/r/ for hand-off pages)
 *   query: /page?x=1&wk={token}    (wkh= for hand-off pages)
 */
export function sessionHref({ carrier, prefix, handoffPrefix, param, handoffParam }, token, path, search = '', handoff = false) {
  if (carrier === 'query') return path + setParam(search, handoff ? handoffParam : param, token);
  return `${handoff ? handoffPrefix : prefix}/${token}${path}${search}`;
}

/**
 * Build a URL rewriter for one response.
 * ctx: { code, carrier, prefix, handoffPrefix, param, handoffParam, handoffPaths, skipPaths, cleanPath,
 *        requestOrigin, upstreamOrigin, sameOrigins: Set<string> }
 */
export function makeUrlRewriter(ctx) {
  const base = ctx.requestOrigin + ctx.cleanPath;
  return function rewriteUrl(raw) {
    const value = raw.trim();
    if (!value || SKIP_SCHEME.test(value)) return raw;
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
    let url;
    try { url = new URL(value, base); } catch { return raw; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
    if (absolute && !ctx.sameOrigins.has(url.origin)) return raw;
    const path = url.pathname;
    if (ASSET_EXT.test(path)) return raw;
    if (path.startsWith(ctx.prefix + '/') || path.startsWith(ctx.handoffPrefix + '/')) return raw;
    if (ctx.param && (getParam(url.search, ctx.param) !== null || getParam(url.search, ctx.handoffParam) !== null)) return raw;
    if (ctx.skipPaths && matchPath(ctx.skipPaths, path)) return raw;
    const href = sessionHref(ctx, ctx.code, path, url.search, matchPath(ctx.handoffPaths, path)) + url.hash;
    if (!absolute) return href;
    const origin = url.origin === ctx.upstreamOrigin ? ctx.requestOrigin : url.origin;
    return origin + href;
  };
}

/**
 * Rewrite navigation links in HTML: <a href>, <area href> and <form action>.
 * <link> tags (canonical, stylesheets, preloads) and src attributes are left alone.
 */
export function rewriteHtml(html, rewriteUrl) {
  return html.replace(/<(?:a|area|form)\b[^>]*>/gi, (tag) =>
    tag.replace(/(\s(?:href|action)\s*=\s*)(["'])(.*?)\2/gi, (_m, attr, q, val) => attr + q + rewriteAttr(val, rewriteUrl) + q));
}

/** Attribute values spell "&" as "&amp;"; rewrite the real URL and keep the page's spelling. */
function rewriteAttr(val, rewriteUrl) {
  if (!/&amp;/i.test(val)) return rewriteUrl(val);
  const url = val.replace(/&amp;/gi, '&');
  const out = rewriteUrl(url);
  return out === url ? val : out.replace(/&/g, '&amp;');
}

/** Rewrite links in Markdown: [text](url), <url>, and bare same-site URLs. */
export function rewriteMarkdown(md, rewriteUrl) {
  // Relative and absolute targets of [text](target "title")
  let out = md.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_m, target, title) => `](${rewriteUrl(target)}${title})`);
  // Autolinks <https://...>
  out = out.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, u) => `<${rewriteUrl(u)}>`);
  // Bare absolute URLs outside link syntax
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s)<>"'\]]+)/g, (_m, pre, u) => pre + rewriteUrl(u));
  return out;
}

export function extractTitle(text, kind) {
  if (kind === 'html') {
    const m = text.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? m[1].trim() : null;
  }
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export function ensureCanonical(html, canonicalUrl) {
  if (/<link[^>]+rel=["']?canonical/i.test(html)) return html;
  const tag = `<link rel="canonical" href="${canonicalUrl}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}\n</head>`);
  return tag + '\n' + html;
}

function blockRe(id) {
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<!--\\s*wake:block\\s+${safe}\\s*-->[\\s\\S]*?<!--\\s*/wake:block(?:\\s+${safe})?\\s*-->`, 'i');
}

/** Ids of every marked block in a page. */
export function listBlocks(text) {
  return [...new Set([...text.matchAll(/<!--\s*wake:block\s+([\w.-]+)\s*-->/gi)].map((m) => m[1]))];
}

export function hasBlock(text, id) {
  return blockRe(id).test(text);
}

/**
 * Insert a snippet at the lead position of a page: after <!-- wake:lead -->, else after <main>,
 * else after <body>, else (Markdown) after the first heading, else at the top.
 */
export function insertAtLead(text, snippet, kind) {
  const anchors = [/<!--\s*wake:lead\s*-->/i, /<main\b[^>]*>/i, /<body\b[^>]*>/i];
  if (kind !== 'html') anchors.push(/^#\s+.+$/m);
  for (const a of anchors) {
    const am = text.match(a);
    if (am) {
      const at = am.index + am[0].length;
      return text.slice(0, at) + '\n' + snippet + '\n' + text.slice(at);
    }
  }
  return snippet + '\n' + text;
}

/**
 * Move an existing marked block to the lead position. Content is only moved,
 * never written, so agents see the same facts as people.
 *   <!-- wake:block mexico -->...<!-- /wake:block -->
 */
export function promoteBlock(text, id, kind) {
  const re = blockRe(id);
  const m = text.match(re);
  if (!m) return { text, applied: false };
  const block = m[0];
  const without = text.slice(0, m.index) + text.slice(m.index + block.length);
  return { text: insertAtLead(without, block, kind), applied: true };
}
