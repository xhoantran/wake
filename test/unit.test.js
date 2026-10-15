import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgent } from '../src/agents.js';
import { parsePrefixed, globToRegExp, unitHash, redact, mintCode, CODE_RE } from '../src/util.js';
import { makeUrlRewriter, rewriteHtml, rewriteMarkdown, promoteBlock, hasBlock, ensureCanonical, extractTitle } from '../src/rewrite.js';
import { scoreIntents, intentsSatisfy } from '../src/intent.js';
import { suggestPath, parseSitemap } from '../src/rescue.js';
import { compare, analyticsLabel } from '../src/reports.js';
import { encodeState, decodeState, formatToken } from '../src/sdk/token.js';

test('session state round-trips through the URL token', () => {
  assert.equal(encodeState([3, 0, 10, 0, 0]), '30a');
  assert.deepEqual(decodeState('30a', 5), [3, 0, 10, 0, 0]);
  assert.deepEqual(decodeState('', 3), [0, 0, 0]);
  assert.equal(encodeState([99]), 'z', 'scores cap at 35');
  assert.equal(formatToken('MW-ABC123', [0, 0]), 'MW-ABC123');
  assert.equal(formatToken('MW-ABC123', [2, 1]), 'MW-ABC123.21');
});

test('classifies live agents, crawlers, search engines and browsers', () => {
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)').kind, 'live');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Claude-User/1.0)').name, 'Claude');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; GPTBot/1.2)').kind, 'training');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; OAI-SearchBot/1.0)').kind, 'search');
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Googlebot/2.1)').kind, 'search-engine');
  assert.equal(classifyAgent('Mozilla/5.0 (Macintosh) AppleWebKit Safari/605'), null);
  assert.equal(classifyAgent('AcmeAgent/2', [{ match: 'AcmeAgent', name: 'Acme', vendor: 'Acme', kind: 'live' }]).name, 'Acme');
});

test('mints codes and parses prefixed paths', () => {
  const code = mintCode('MW');
  assert.match(code, CODE_RE);
  assert.deepEqual(parsePrefixed(`/a/${code}/plans/family`, '/a'), { code, state: '', token: code, rest: '/plans/family' });
  assert.deepEqual(parsePrefixed(`/a/${code}`, '/a'), { code, state: '', token: code, rest: '/' });
  assert.deepEqual(parsePrefixed(`/a/${code}.30a/x`, '/a'), { code, state: '30a', token: `${code}.30a`, rest: '/x' });
  assert.equal(parsePrefixed(`/a/${code}.3A/x`, '/a'), null, 'state is lowercase base 36');
  assert.equal(parsePrefixed('/a/not a code/x', '/a'), null);
  assert.equal(parsePrefixed('/about', '/a'), null);
});

test('glob matching', () => {
  assert.ok(globToRegExp('/travel/**').test('/travel/international-pass'));
  assert.ok(globToRegExp('/plans/*').test('/plans/family'));
  assert.ok(!globToRegExp('/plans/*').test('/plans/family/extra'));
  assert.ok(globToRegExp('/plans/family').test('/plans/family/'));
});

test('holdout hash is stable and in range', () => {
  const a = unitHash('MW-ABCDEF:rule');
  assert.equal(a, unitHash('MW-ABCDEF:rule'));
  assert.ok(a >= 0 && a < 1);
  const n = 4000;
  let low = 0;
  for (let i = 0; i < n; i++) if (unitHash(`MW-${i}:rule`) < 0.2) low++;
  assert.ok(Math.abs(low / n - 0.2) < 0.03, `holdout share ${low / n}`);
});

test('redacts emails, phone numbers and street addresses', () => {
  const r = redact('home internet at 1200 Main Street for jo@x.com call +1 (415) 555-0100');
  assert.ok(!r.includes('Main Street') && !r.includes('jo@x.com') && !r.includes('555-0100'), r);
  assert.equal(redact('family plan 4 lines keep our iphones'), 'family plan 4 lines keep our iphones');
});

const ctx = {
  code: 'MW-ABC123', prefix: '/a', handoffPrefix: '/r', handoffPaths: ['/signup'], skipPaths: ['/_wake/**'],
  cleanPath: '/plans/family', requestOrigin: 'https://proxy.test', upstreamOrigin: 'http://127.0.0.1:4000',
  sameOrigins: new Set(['https://proxy.test', 'http://127.0.0.1:4000', 'https://meridian.example']),
};

test('rewrites site links to carry the session code', () => {
  const rw = makeUrlRewriter(ctx);
  assert.equal(rw('/travel'), '/a/MW-ABC123/travel');
  assert.equal(rw('../compare/crestline'), '/a/MW-ABC123/compare/crestline');
  assert.equal(rw('/signup?plan=x&amp;lines=4'), '/r/MW-ABC123/signup?plan=x&amp;lines=4');
  assert.equal(rw('https://meridian.example/about#team'), 'https://meridian.example/a/MW-ABC123/about#team');
  assert.equal(rw('http://127.0.0.1:4000/deals'), 'https://proxy.test/a/MW-ABC123/deals');
  for (const keep of ['https://twitter.com/x', 'mailto:a@b.c', '#top', '/style.css', '/a/MW-ABC123/x', '/_wake/', 'javascript:void(0)']) {
    assert.equal(rw(keep), keep, keep);
  }
});

test('rewrites HTML attributes and Markdown links', () => {
  const rw = makeUrlRewriter(ctx);
  const html = rewriteHtml('<a href="/x">x</a><img src="/y.png"><form action=\'/search\'></form>', rw);
  assert.equal(html, '<a href="/a/MW-ABC123/x">x</a><img src="/y.png"><form action=\'/a/MW-ABC123/search\'></form>');
  const head = '<link rel="canonical" href="https://meridian.example/plans"><link rel="stylesheet" href="/s.css"><link rel="alternate" href="/feed">';
  assert.equal(rewriteHtml(head, rw), head, 'link tags are never rewritten');
  const md = rewriteMarkdown('See [compare](/compare/crestline "c") or <https://meridian.example/plans>.\nOrder: https://meridian.example/signup\nOther: https://example.org/x', rw);
  assert.ok(md.includes('](/a/MW-ABC123/compare/crestline "c")'));
  assert.ok(md.includes('<https://meridian.example/a/MW-ABC123/plans>'));
  assert.ok(md.includes('Order: https://meridian.example/r/MW-ABC123/signup'));
  assert.ok(md.includes('Other: https://example.org/x'));
});

test('promotes an existing block without changing its content', () => {
  const page = '<html><head><title>T</title></head><body><main><!-- wake:lead --><h1>T</h1><p>$10 a day</p><!-- wake:block mx --><p>Mexico included</p><!-- /wake:block --></main></body></html>';
  assert.ok(hasBlock(page, 'mx'));
  const { text, applied } = promoteBlock(page, 'mx', 'html');
  assert.ok(applied);
  assert.ok(text.indexOf('Mexico included') < text.indexOf('$10 a day'));
  assert.equal(text.match(/Mexico included/g).length, 1);
  assert.equal(text.replace(/\s/g, '').length, page.replace(/\s/g, '').length);
  assert.equal(promoteBlock(page, 'missing', 'html').applied, false);
  const md = promoteBlock('# Title\n\n- price\n<!-- wake:block mx -->\n- mexico\n<!-- /wake:block -->\n', 'mx', 'markdown').text;
  assert.ok(md.indexOf('mexico') < md.indexOf('price'));
});

test('canonical link and title', () => {
  assert.ok(ensureCanonical('<head></head>', 'https://s/x').includes('<link rel="canonical" href="https://s/x">'));
  assert.equal(ensureCanonical('<link rel="canonical" href="/y"><head></head>', 'https://s/x'), '<link rel="canonical" href="/y"><head></head>');
  assert.equal(extractTitle('<title> Plans </title>', 'html'), 'Plans');
  assert.equal(extractTitle('intro\n# Fact sheet\n', 'markdown'), 'Fact sheet');
});

test('scores intents from paths and questions', () => {
  const intents = [
    { id: 'family', label: 'Family', paths: ['/plans/family'], keywords: ['family', 'lines'] },
    { id: 'travel', label: 'Travel', paths: ['/travel/**'], keywords: ['mexico', 'keep number'] },
  ];
  const s = scoreIntents([{ path: '/plans/family' }, { path: '/search', query: 'family plan 4 lines mexico, keep number' }], intents);
  assert.equal(s[0].id, 'family');
  assert.equal(s.find((i) => i.id === 'travel').score, 2);
  assert.ok(intentsSatisfy({ intents: ['family', 'travel'] }, s));
  assert.ok(!intentsSatisfy({ intents: ['family', 'cancel'] }, s));
  assert.ok(intentsSatisfy({ anyIntents: ['cancel', 'travel'] }, s));
});

test('rescues guessed URLs', () => {
  const pages = ['/plans/family', '/travel/international-pass', '/compare/crestline', '/support/cancel'];
  const opts = { aliases: { '/pricing': '/plans/family' }, synonyms: { roaming: ['travel', 'international'] } };
  assert.equal(suggestPath('/plans/international-roaming', pages, opts).to, '/travel/international-pass');
  assert.equal(suggestPath('/pricing', pages, opts).to, '/plans/family');
  assert.equal(suggestPath('/cancel-service', pages, opts).to, '/support/cancel');
  assert.equal(suggestPath('/careers/engineering', pages, opts), null);
  assert.deepEqual(parseSitemap('<urlset><url><loc>https://x.com/a/b</loc></url><url><loc> https://x.com/c </loc></url></urlset>'), ['/a/b', '/c']);
});

test('experiment stats and analytics labels', () => {
  // 6.0% vs 4.1%: the interval still crosses zero at 1,000 per group, and clears it at 2,000.
  const small = compare({ n: 1000, k: 60 }, { n: 1000, k: 41 });
  assert.ok(Math.abs(small.diff - 0.019) < 1e-9);
  assert.ok(small.low < 0 && small.high > 0);
  const c = compare({ n: 2000, k: 120 }, { n: 2000, k: 82 });
  assert.ok(c.low > 0 && c.high > c.low && c.enough);
  assert.equal(compare({ n: 5, k: 1 }, { n: 3, k: 0 }).enough, false);
  assert.equal(analyticsLabel(''), 'Direct');
  assert.equal(analyticsLabel('https://chatgpt.com/'), 'AI referral');
  assert.equal(analyticsLabel('https://www.google.com/'), 'Organic search');
  assert.equal(analyticsLabel('https://news.ycombinator.com/'), 'Referral');
});
