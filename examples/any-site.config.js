// Minimal config for putting Wake in front of any site:
//   WAKE_UPSTREAM=https://www.example.com node bin/wake.js --config examples/any-site.config.js
// Uses /w/ as the session prefix so it can't collide with a site's own paths.
const upstream = process.env.WAKE_UPSTREAM;
export default {
  upstream,
  sameSiteOrigins: upstream ? [new URL(upstream).origin.replace('://www.', '://'), new URL(upstream).origin.replace('://', '://www.')] : [],
  prefix: '/w',
  handoffPrefix: '/go',
  codePrefix: 'WK',
  handoffPaths: ['/signup', '/sign-up', '/register', '/r/**', '/checkout/**', '/pricing/checkout'],
  // Example: ignore a site's own per-visit path codes (here /a/NW-XXXXXX/) in analytics.
  pathRewrites: [['^/a/NW-[A-Z0-9]+(?=/|$)', '']],
  aliases: {},
  synonyms: { pricing: ['plans', 'price'], plans: ['pricing'], docs: ['help', 'guide'] },
};
