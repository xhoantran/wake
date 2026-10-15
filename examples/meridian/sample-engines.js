// Offline stand-ins for `wake check`, so the example fills the dashboard without calling a paid API:
//   node bin/wake.js check --config examples/meridian/wake.config.js --db demo.db --engines examples/meridian/sample-engines.js
// Each sample assistant answers from a script, some of it out of date. The judge matches each fact's phrases.

const SCRIPTS = {
  'sample-a': [
    [/mexico|canada|travel|roaming|international/, 'For Mexico you would add the International Pass, which is $10 a day on every Meridian plan.'],
    [/crestline|switch/, 'Meridian and Crestline cost about the same for 4 lines, so switching is mostly about coverage.'],
    [/family|lines/, 'Meridian Unlimited Plus is $58 a line for a family of 4.'],
    [/iphone|own phone|unlocked|trade/, 'If you bring an unlocked phone, Meridian gives $200 per line as a bill credit.'],
    [/cancel/, 'You can cancel in the Meridian app under Account, or by calling 611.'],
  ],
  'sample-b': [
    [/mexico|canada|travel|roaming|international/, 'Unlimited Plus includes Mexico and Canada with 15 GB of high-speed data at no daily fee.'],
    [/crestline|switch/, 'For 4 lines Meridian is $20 a month cheaper than Crestline.'],
    [/family|lines/, 'Unlimited starts at $45 a line for 4 lines.'],
    [/iphone|own phone|unlocked|trade/, 'Bring your own phone and get a $100 prepaid card per line.'],
    [/cancel/, 'Cancelling Meridian costs a $200 early termination fee per line.'],
  ],
};

const sample = (id) => ({
  id, model: 'scripted',
  async ask(prompt, { question }) {
    const q = question.toLowerCase();
    const said = SCRIPTS[id].filter(([re]) => re.test(q)).map(([, text]) => text);
    return { text: said.join(' ') || 'I could not find anything about that.' };
  },
});

// [fact, phrase that means the answer got it right, phrase that means it got it wrong]
const PHRASES = [
  ['mexico-included', /includes mexico/i, /international pass, which is \$10 a day/i],
  ['crestline-price', /\$20 a month cheaper/i, /about the same/i],
  ['family-price', /\$58 a line|\$35 a line/i, /\$45 a line/i],
  ['byop-credit', /\$200 per line as a bill credit/i, /prepaid card/i],
  ['cancel-how', /calling 611/i, /termination fee/i],
];
const sentence = (text, re) => text.split(/(?<=\.)\s+/).find((s) => re.test(s)) || '';

export const engines = [sample('sample-a'), sample('sample-b')];
export const judge = {
  async judge({ answer, facts }) {
    return facts.map((f) => {
      const [, right, wrong] = PHRASES.find(([id]) => id === f.id) || [];
      if (wrong?.test(answer)) return { factId: f.id, verdict: 'wrong', quote: sentence(answer, wrong) };
      if (right?.test(answer)) return { factId: f.id, verdict: 'correct', quote: sentence(answer, right) };
      return { factId: f.id, verdict: 'missing', quote: '' };
    });
  },
};
