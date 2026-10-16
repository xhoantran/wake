// Wake config for the fictional Meridian Wireless example site.
export default {
  name: 'Meridian Wireless (example)',
  upstream: 'http://127.0.0.1:4000',
  sameSiteOrigins: ['https://meridian.example'],
  codePrefix: 'MW',
  handoffPaths: ['/signup', '/checkout/**'],

  intents: [
    { id: 'family', label: 'Family plan, several lines', paths: ['/plans/family'], keywords: ['family', 'lines', 'kids'],
      pitch: 'Unlimited Plus is $58 a line for 4 lines.' },
    { id: 'travel', label: 'International travel', paths: ['/travel/**'], keywords: ['mexico', 'canada', 'international', 'roaming', 'travel'] },
    { id: 'switch', label: 'Switching carriers', paths: ['/compare/**'], keywords: ['switch', 'crestline', 'port', 'keep number'] },
    { id: 'byop', label: 'Bringing their own phone', paths: ['/deals/bring-your-own-phone'], keywords: ['iphone', 'iphones', 'unlocked', 'own phone', 'keep our'] },
    { id: 'cancel', label: 'Cancelling', paths: ['/support/cancel'], keywords: ['cancel', 'termination'] },
  ],

  blocks: {
    'mexico-included': 'Mexico and Canada are included on Unlimited Plus.',
    'crestline-price': 'For 4 lines Meridian is $20 a month cheaper than Crestline.',
    'family-trade-in': 'Up to $400 per line in trade-in credit.',
    'cancel-steps': 'Cancellation steps first; mention loyalty pricing only after.',
  },

  rules: [
    { id: 'mexico-first', when: { intents: ['family', 'travel'], path: ['/travel/**', '/agents.md'] }, promote: 'mexico-included', holdout: 0.2 },
    { id: 'crestline-side-by-side', when: { anyIntents: ['switch'], path: '/compare/**' }, promote: 'crestline-price', holdout: 0.2 },
    { id: 'cancel-steps-first', when: { anyIntents: ['cancel'], path: '/support/cancel' }, promote: 'cancel-steps', holdout: 0.1 },
  ],

  aliases: { '/pricing': '/plans/family', '/cancel': '/support/cancel' },
  synonyms: { roaming: ['travel', 'international'], abroad: ['travel', 'international'], switching: ['compare'] },
  conversions: [{ name: 'order', method: 'POST', path: '/checkout/order' }],

  // The site's facts. The research brief shows them, grouped by the intents each one answers, and links
  // each to its source page. `wake check` also judges assistants' answers against them.
  // `wake facts` checks that every number in a fact still appears on its source page.
  facts: [
    { id: 'mexico-included', claim: 'Mexico and Canada are included on Unlimited Plus', intents: ['travel'], source: '/travel/international-pass',
      truth: 'Unlimited Plus includes calls, texts and 15 GB of high-speed data in Mexico and Canada at no daily fee. The $10 a day International Pass is only needed elsewhere or on other plans.',
      blocks: ['mexico-included'] },
    { id: 'crestline-price', claim: 'Meridian vs Crestline for 4 lines', intents: ['switch'], source: '/compare/crestline',
      truth: 'For 4 lines, Meridian Unlimited Plus is $232 a month and Crestline Global 4 is $252 a month.',
      blocks: ['crestline-price'] },
    { id: 'switch-time', claim: 'Switching takes about 15 minutes', intents: ['switch'], source: '/compare/crestline',
      truth: 'Switching takes about 15 minutes and you keep your numbers.' },
    { id: 'family-price', claim: 'Family plan prices', intents: ['family'], source: '/plans/family',
      truth: 'Unlimited is $35 a line for 4 lines. Unlimited Plus is $58 a line.' },
    { id: 'family-trade-in', claim: 'Trade-in credit', intents: ['family', 'byop'], source: '/plans/family',
      truth: 'Up to $400 per line when you trade in a phone and add 4 lines.', blocks: ['family-trade-in'] },
    { id: 'byop-credit', claim: 'Bring-your-own-phone credit', intents: ['byop'], source: '/deals/bring-your-own-phone',
      truth: 'Bringing an unlocked phone earns $200 per line as a bill credit over 24 months.' },
    { id: 'cancel-how', claim: 'How to cancel', intents: ['cancel'], source: '/support/cancel',
      truth: 'Cancel any time in the app (Account, then Cancel service) or by calling 611. Service ends at the end of the bill cycle. Devices on a payment plan become due in full.',
      blocks: ['cancel-steps'] },
  ],

  // Tracking only: sessions, intents, hand-offs and conversions. Pages are never changed and guessed URLs
  // are reported, not redirected. Switch to mode: 'route' to turn on the rules above, and set
  // brief.enabled to add the research brief.
  mode: 'trace',
  brief: { enabled: false, ctaPath: '/signup', ctaText: 'Order online', holdout: 0.5 },

  // `wake check` asks assistants the top questions agents searched for, then judges the answers against these facts.
  answerChecks: {
    site: 'Meridian Wireless (meridian.example)',
    engines: [{ type: 'claude' }],   // needs ANTHROPIC_API_KEY; see sample-engines.js for an offline run
  },
};
