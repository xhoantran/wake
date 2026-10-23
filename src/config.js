const DEFAULTS = {
  upstream: null,            // proxy mode only: origin Wake fetches pages from, e.g. "https://www.example.com"
  enabled: true,             // kill switch: false = pass everything through (session URLs still redirect to clean URLs)
  mode: 'trace',             // shadow = observe only, never change a response
                             // trace  = sessions and link rewriting, no content rules or redirects for guessed URLs (the default)
                             // route  = everything: content rules, the research brief and redirects for guessed URLs (opt in)
  maxTransformBytes: 5_000_000, // larger agent responses pass through untouched
  transform: null,           // optional (text, info) => text hook for agent pages; errors fail open
  knownPaths: [],            // extra real paths for guessed-URL redirects (the sitemap is read too)
  botSampleRate: 1,          // share of crawler requests reported
  publicOrigin: null,        // the site's public origin, used for canonical links (defaults to the request origin)
  sameSiteOrigins: [],       // other origins that count as this site when rewriting absolute links
  carrier: 'path',           // how links carry the session code:
                             //   path  = /a/{code}/page   (prefix, handoffPrefix)
                             //   query = /page?wk={code}  (param, handoffParam); the site's routes never change
                             //   split = half the sessions each, compared on the dashboard ("link-carrier")
                             // Incoming links are read in both forms whatever this is set to.
  prefix: '/a',              // agent session path:   /a/{code}/...
  handoffPrefix: '/r',       // person-takes-over path: /r/{code}/...
  param: 'wk',               // agent session query parameter:   ?wk={code}
  handoffParam: 'wkh',       // person-takes-over query parameter: ?wkh={code}
  codePrefix: 'WK',
  trackKinds: ['live'],      // agent kinds that get sessions; index and training crawlers must not
  handoffPaths: [],          // pages whose links should become /r/ links (sign-up, checkout)
  skipPaths: [],             // links Wake never rewrites
  pathRewrites: [],          // [[regex, replacement]] applied to paths before analytics, intents and rules
                             // e.g. [['^/a/NW-[A-Z0-9]+(?=/|$)', '']] to ignore a site's own path codes
  search: { paths: ['/search'], params: ['q', 'query', 's'] },
  intents: [],               // [{ id, label, paths, keywords, pitch }]
  minIntentScore: 2,
  blocks: {},                // { blockId: 'Human-readable summary, used in briefs' }
  rules: [],                 // [{ id, when: { path, intents, anyIntents }, promote: blockId, holdout: 0.2 }]
  aliases: {},               // exact redirects for guessed URLs: { '/pricing': '/plans' }
  synonyms: {},              // { roaming: ['travel', 'international'] }
  rescueThreshold: 0.34,
  conversions: [],           // [{ name, method, path, value }]
  facts: [],                 // the site's facts: [{ id, claim, truth, source: '/page', intents: [intentId], blocks: [blockId] }]
                             // used by the research brief and answer checks (falls back to answerChecks.facts)
  brief: {
    enabled: false,          // per-session research brief at /a/{token}{path}, linked from routed sessions' pages
    path: '/research-brief',
    title: 'Research summary',
    linkText: 'Summary of this visit',
    ctaPath: null,           // e.g. '/signup'; becomes a hand-off link when it matches handoffPaths
    ctaText: 'Next step',
    maxFacts: 8,
    holdout: 0.5,            // share of eligible sessions that never get the link
    when: {},                // optional extra condition, same shape as a rule's `when` (intents, anyIntents)
  },
  shadowWindowMs: 30 * 60 * 1000, // collector: group shadow-mode reads by IP hash and user-agent within this window
  cookieName: 'wake_sid',
  cookieDays: 30,
  agents: [],                // extra agent signatures, checked before the built-in list
  dashboard: { path: '/_wake', token: null },
  answerChecks: {
    site: null,              // how questions name the site, e.g. "Meridian Wireless (meridian.example)"; defaults to name or host
    questions: [],           // questions to ask; empty = the top questions Wake has captured from agents
    maxQuestions: 10,
    facts: [],               // [{ id, claim, truth, blocks: [blockId] }]
    engines: [{ type: 'claude' }], // assistants to ask; see src/checks.js for the engine interface
    judge: { type: 'claude' },
  },
};

export function normalizeConfig(c) {
  if (!c) throw new Error('wake: a config object is required');
  if (c.mode && !['shadow', 'trace', 'route'].includes(c.mode)) throw new Error(`wake: mode must be shadow, trace or route (got ${c.mode})`);
  const cfg = { ...DEFAULTS, ...c };
  cfg.search = { ...DEFAULTS.search, ...(c.search || {}) };
  cfg.dashboard = { ...DEFAULTS.dashboard, ...(c.dashboard || {}) };
  cfg.answerChecks = { ...DEFAULTS.answerChecks, ...(c.answerChecks || {}) };
  cfg.brief = { ...DEFAULTS.brief, ...(c.brief || {}) };
  if (!Array.isArray(cfg.facts)) throw new Error('wake: facts must be a list');
  for (const f of cfg.facts) {
    if (!f?.id || !f.truth) throw new Error(`wake: every fact needs an id and the truth (${JSON.stringify(f)})`);
    f.blocks = f.blocks || [];
    if (f.source && !String(f.source).startsWith('/')) throw new Error(`wake: fact "${f.id}" source must be a site path starting with "/"`);
  }
  if (!cfg.answerChecks.facts.length && cfg.facts.length) cfg.answerChecks.facts = cfg.facts.filter((f) => f.claim);
  for (const f of cfg.answerChecks.facts) {
    if (!f.id || !f.claim || !f.truth) throw new Error(`wake: every answerChecks fact needs an id, a claim and the truth (${JSON.stringify(f)})`);
    f.blocks = f.blocks || [];
  }
  cfg.siteFacts = cfg.facts.length ? cfg.facts : cfg.answerChecks.facts;
  if (!String(cfg.brief.path).startsWith('/')) throw new Error('wake: brief.path must start with "/"');
  if (typeof cfg.brief.holdout !== 'number' || !(cfg.brief.holdout >= 0 && cfg.brief.holdout <= 1)) {
    throw new Error(`wake: brief.holdout must be between 0 and 1 (got ${JSON.stringify(cfg.brief.holdout)})`);
  }
  cfg.upstreamOrigin = cfg.upstream ? new URL(cfg.upstream).origin : null;
  for (const k of ['prefix', 'handoffPrefix']) cfg[k] = '/' + cfg[k].replace(/^\/+|\/+$/g, '');
  if (!['path', 'query', 'split'].includes(cfg.carrier)) throw new Error(`wake: carrier must be path, query or split (got ${cfg.carrier})`);
  for (const k of ['param', 'handoffParam']) {
    if (typeof cfg[k] !== 'string' || !/^[a-z][a-z0-9_]{0,15}$/i.test(cfg[k])) throw new Error(`wake: ${k} must be a short name of letters, digits and _ (got ${JSON.stringify(cfg[k])})`);
  }
  if (cfg.param === cfg.handoffParam) throw new Error('wake: param and handoffParam must differ');
  if (!Array.isArray(cfg.intents)) throw new Error('wake: intents must be a list');
  if (!Array.isArray(cfg.rules)) throw new Error('wake: rules must be a list');
  if (!cfg.blocks || typeof cfg.blocks !== 'object' || Array.isArray(cfg.blocks)) throw new Error('wake: blocks must be an object of { blockId: summary }');
  for (const [id, summary] of Object.entries(cfg.blocks)) {
    if (typeof summary !== 'string') throw new Error(`wake: block "${id}" needs a text summary`);
  }
  const seen = new Set();
  for (const i of cfg.intents) {
    if (!i?.id || typeof i.id !== 'string') throw new Error(`wake: every intent needs an id (${JSON.stringify(i)})`);
    if (seen.has('intent:' + i.id)) throw new Error(`wake: two intents have the id "${i.id}"`);
    seen.add('intent:' + i.id);
  }
  for (const r of cfg.rules) {
    if (!r?.id || !r.promote) throw new Error(`wake: every rule needs an id and a promote block (${JSON.stringify(r)})`);
    if (seen.has('rule:' + r.id)) throw new Error(`wake: two rules have the id "${r.id}"`);
    if (r.id === 'research-brief') throw new Error('wake: the rule id "research-brief" is reserved for the research brief');
    if (r.id === 'link-carrier') throw new Error('wake: the rule id "link-carrier" is reserved for the carrier split test');
    seen.add('rule:' + r.id);
    r.holdout = r.holdout ?? 0.2;
    if (typeof r.holdout !== 'number' || !(r.holdout >= 0 && r.holdout <= 1)) {
      throw new Error(`wake: rule "${r.id}" needs a holdout share between 0 and 1 (got ${JSON.stringify(r.holdout)})`);
    }
  }
  const rewrites = cfg.pathRewrites.map(([re, to]) => [re instanceof RegExp ? re : new RegExp(re), to]);
  cfg.normalizePath = (p) => rewrites.reduce((acc, [re, to]) => acc.replace(re, to), p) || '/';
  return cfg;
}
