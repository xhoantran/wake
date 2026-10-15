// Answer checks end to end: agents search the real example site through Wake, then fake assistants are asked
// the captured questions and a fake judge scores them. No test calls a paid API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSite } from '../examples/meridian/site-server.js';
import baseConfig from '../examples/meridian/wake.config.js';
import { createWake } from '../src/wake.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/node.js';
import { normalizeConfig } from '../src/config.js';
import { runChecks, cleanVerdicts, claudeEngine, claudeJudge, resolveEngine, registerEngine, checkQuestions } from '../src/checks.js';
import { unitHash } from '../src/util.js';
import { walk } from './helpers.js';

const CHATGPT = 'Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let site, proxy, wake, store, W;

before(async () => {
  site = createSite();
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  store = openStore(':memory:');
  wake = createWake({ ...structuredClone(baseConfig), upstream: `http://127.0.0.1:${site.address().port}` }, { store });
  proxy = await serve(wake, { port: 0, trustProxy: true });
  W = `http://127.0.0.1:${proxy.address().port}`;
});
after(() => { proxy.close(); site.close(); });

function get(p, { ip = '20.0.0.1' } = {}) {
  return fetch(W + p, { redirect: 'manual', headers: { 'user-agent': CHATGPT, 'x-forwarded-for': ip } });
}

function codeFor(rule, arm, holdout = 0.2) {
  for (let i = 0; i < 10000; i++) {
    const code = `MW-CHK${String(i).padStart(4, '0')}`;
    if ((unitHash(`${code}:${rule}`) < holdout) === (arm === 'holdout')) return code;
  }
}

/** A fake assistant: scripted answers, and a record of every prompt it was given. */
function fakeEngine(id, script) {
  const prompts = [];
  return { id, model: `${id}-v1`, prompts, async ask(prompt, { question }) { prompts.push(prompt); return { text: script(question) }; } };
}

/** A fake judge: a fact is wrong if the answer contains its wrong phrase, correct if it contains its right phrase. */
const PHRASES = { 'mexico-included': ['includes Mexico', '$10 a day'], 'crestline-price': ['$20 a month cheaper', 'same price'] };
const fakeJudge = {
  calls: 0,
  async judge({ answer, facts }) {
    this.calls++;
    return facts.map((f) => {
      const [right, wrong] = PHRASES[f.id] || [];
      if (wrong && answer.includes(wrong)) return { factId: f.id, verdict: 'wrong', quote: answer };
      if (right && answer.includes(right)) return { factId: f.id, verdict: 'correct', quote: answer };
      return { factId: f.id, verdict: 'missing', quote: '' };
    });
  },
};

test('answer checks ask the captured questions and the dashboard shows wrong claims with their fix', async () => {
  // Agents search the site; Wake captures the questions. One routed session reads the travel page.
  const code = codeFor('mexico-first', 'routed');
  await walk(get, code, ['/plans/family', `/search?q=${encodeURIComponent('family plan mexico travel')}`, '/travel/international-pass']);
  await get(`/search?q=${encodeURIComponent('switch from crestline')}`, { ip: '20.0.0.2' });

  assert.deepEqual(checkQuestions(store, wake.config).sort(), ['family plan mexico travel', 'switch from crestline']);

  const outdated = fakeEngine('assistant-a', (q) => (q.includes('mexico') ? 'Mexico costs $10 a day with the International Pass.' : 'They are about the same price as Crestline.'));
  const current = fakeEngine('assistant-b', (q) => (q.includes('mexico') ? 'Unlimited Plus includes Mexico and Canada.' : 'Meridian is $20 a month cheaper for 4 lines.'));
  const s = await runChecks({ config: wake.config, store, engines: [outdated, current], judge: fakeJudge });
  assert.equal(s.answers, 4);
  assert.equal(s.errors, 0);
  assert.equal(s.wrong, 2);
  assert.equal(fakeJudge.calls, 4);
  assert.ok(outdated.prompts[0].includes('Meridian Wireless (meridian.example)'), 'the prompt names the site');

  const o = await (await get('/_wake/api/overview', { ip: '127.0.0.1' })).json();
  const a = o.answers;
  assert.equal(a.answers, 4);
  assert.equal(a.questions, 2);
  assert.deepEqual(a.engines.sort(), ['assistant-a', 'assistant-b']);
  const mexico = a.facts[0];
  assert.equal(mexico.id, 'mexico-included', 'facts with wrong claims come first');
  assert.deepEqual([mexico.correct, mexico.wrong], [1, 1]);
  assert.equal(mexico.claims[0].engine, 'assistant-a');
  assert.equal(mexico.claims[0].quote, 'Mexico costs $10 a day with the International Pass.');
  assert.equal(mexico.claims[0].question, 'family plan mexico travel');
  // The wrong answer links to the rule that promotes the fact's block, with its holdout numbers.
  assert.equal(mexico.fixes[0].block, 'mexico-included');
  const rule = mexico.fixes[0].rules[0];
  assert.equal(rule.id, 'mexico-first');
  assert.equal(rule.routed.n, 1);
  assert.ok('handoff' in rule && 'low' in rule.handoff);
  const family = a.facts.find((f) => f.id === 'family-price');
  assert.deepEqual(family.fixes, [], 'a fact with no blocks has no fix to point to');

  // "crestline-price": the routed rule exists but no session has seen it yet; the wrong claim is still listed.
  const crest = a.facts.find((f) => f.id === 'crestline-price');
  assert.deepEqual([crest.correct, crest.wrong], [1, 1]);
  assert.equal(crest.fixes[0].rules[0].id, 'crestline-side-by-side');

  // Every stored answer is available, verdicts included.
  const list = await (await get('/_wake/api/answers', { ip: '127.0.0.1' })).json();
  assert.equal(list.length, 4);
  assert.equal(list[0].verdicts.length, baseConfig.answerChecks.facts.length);

  const page = await (await get('/_wake/', { ip: '127.0.0.1' })).text();
  assert.ok(page.includes('What agents say vs the truth'));
});

test('a failing engine is recorded and the run carries on; the latest run wins', async () => {
  const broken = { id: 'broken', async ask() { throw new Error('rate limited'); } };
  const ok = fakeEngine('assistant-b', () => 'Unlimited Plus includes Mexico and Canada.');
  let t = Date.now() + 60_000;
  const s = await runChecks({ config: wake.config, store, engines: [broken, ok], judge: fakeJudge, questions: ['mexico?'], now: () => t++ });
  assert.equal(s.answers, 2);
  assert.equal(s.errors, 1);
  const o = await (await get('/_wake/api/overview', { ip: '127.0.0.1' })).json();
  assert.equal(o.answers.answers, 2, 'only the latest run is reported');
  assert.equal(o.answers.wrong, 0);
  assert.equal(o.answers.errors[0].error, 'rate limited');
});

test('runChecks refuses to run without facts or questions', async () => {
  const empty = normalizeConfig({ upstream: 'http://127.0.0.1:9' });
  await assert.rejects(runChecks({ config: empty, store: openStore(), engines: [], judge: fakeJudge }), /facts is empty/);
  const noQs = normalizeConfig({ upstream: 'http://127.0.0.1:9', answerChecks: { facts: [{ id: 'a', claim: 'x', truth: 'y' }] } });
  await assert.rejects(runChecks({ config: noQs, store: openStore(), engines: [], judge: fakeJudge }), /no questions/);
  assert.throws(() => normalizeConfig({ upstream: 'http://x', answerChecks: { facts: [{ id: 'a' }] } }), /needs an id, a claim and the truth/);
});

test('verdicts are cleaned: unknown facts and verdicts dropped, skipped facts count as missing', () => {
  const facts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = cleanVerdicts([
    { factId: 'a', verdict: 'wrong', quote: 'said X' },
    { factId: 'a', verdict: 'correct', quote: 'dupe' },
    { factId: 'b', verdict: 'maybe', quote: '' },
    { factId: 'zzz', verdict: 'wrong', quote: '' },
    { factId: 'c', verdict: 'missing', quote: 'should be blank' },
  ], facts);
  assert.deepEqual(out, [
    { factId: 'a', verdict: 'wrong', quote: 'said X' },
    { factId: 'b', verdict: 'missing', quote: '' },
    { factId: 'c', verdict: 'missing', quote: '' },
  ]);
  assert.equal(cleanVerdicts('not a list', facts).length, 3);
});

test('the Claude engine and judge send the right requests (fake fetch, no network)', async () => {
  const sent = [];
  const reply = (content, extra = {}) => new Response(JSON.stringify({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content, ...extra }), { headers: { 'content-type': 'application/json' } });
  const fakeFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (sent.length === 1) return new Response('{"error":"overloaded"}', { status: 529, headers: { 'retry-after': '0' } });
    if (sent.length === 2) return reply([{ type: 'text', text: 'Mexico is $10 a day.' }]);
    return reply([{ type: 'text', text: JSON.stringify({ verdicts: [{ factId: 'mexico-included', verdict: 'wrong', quote: 'Mexico is $10 a day.' }] }) }]);
  };
  const engine = claudeEngine({ apiKey: 'test-key', fetch: fakeFetch });
  const a = await engine.ask('Is Mexico included?');
  assert.equal(a.text, 'Mexico is $10 a day.');
  assert.equal(sent.length, 2, 'retried once after a 529');
  assert.equal(sent[1].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[1].headers['x-api-key'], 'test-key');
  assert.equal(sent[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(sent[1].body.model, 'claude-opus-5-5');
  assert.equal(sent[1].body.fallbacks, 'default');
  assert.deepEqual(sent[1].body.messages, [{ role: 'user', content: 'Is Mexico included?' }]);
  assert.equal(sent[1].body.tools, undefined, 'no web search unless asked');

  const facts = normalizeConfig(baseConfig).answerChecks.facts;
  const judge = claudeJudge({ apiKey: 'test-key', fetch: fakeFetch });
  const v = await judge.judge({ question: 'Is Mexico included?', answer: a.text, facts, site: 'Meridian' });
  assert.deepEqual(v, [{ factId: 'mexico-included', verdict: 'wrong', quote: 'Mexico is $10 a day.' }]);
  const fmt = sent[2].body.output_config.format;
  assert.equal(fmt.type, 'json_schema');
  assert.deepEqual(fmt.schema.properties.verdicts.items.properties.verdict.enum, ['correct', 'wrong', 'missing']);
  assert.deepEqual(fmt.schema.properties.verdicts.items.properties.factId.enum, facts.map((f) => f.id));
  assert.ok(sent[2].body.messages[0].content.includes('truth: Unlimited Plus includes calls'));

  await assert.rejects(claudeEngine({ apiKey: '' }).ask('x'), /ANTHROPIC_API_KEY/);
});

test('engines are pluggable by type', async () => {
  registerEngine('echo', ({ id = 'echo' }) => ({ id, ask: async (p) => ({ text: p }) }));
  const e = resolveEngine({ type: 'echo', id: 'echo-1' });
  assert.equal(e.id, 'echo-1');
  assert.equal((await e.ask('hi')).text, 'hi');
  assert.throws(() => resolveEngine({ type: 'nope' }), /unknown answer engine type "nope"/);
});

test('wake check fills the dashboard for the example with the offline sample engines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-check-'));
  const db = path.join(dir, 'wake.db');
  const seed = openStore(db);
  for (const [i, q] of ['family plan 4 lines mexico travel', 'switch from crestline keep number', 'how do i cancel'].entries()) {
    seed.addEvent({ ts: Date.now(), code: `MW-SEED0${i}`, type: 'fetch', actor: 'agent', path: '/search', query: q, status: 200 });
  }
  seed.close();
  const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', 'bin/wake.js', 'check',
    '--config', 'examples/meridian/wake.config.js', '--db', db, '--engines', 'examples/meridian/sample-engines.js'],
  { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  assert.match(stdout, /Asked 3 questions of sample-a, sample-b: 6 answers/);

  const s = openStore(db);
  const config = normalizeConfig(baseConfig);
  const { overview } = await import('../src/reports.js');
  const a = overview(s, config).answers;
  assert.equal(a.answers, 6);
  assert.ok(a.wrong >= 3, `wrong claims: ${a.wrong}`);
  const mexico = a.facts.find((f) => f.id === 'mexico-included');
  assert.equal(mexico.claims[0].engine, 'sample-a');
  assert.equal(mexico.fixes[0].rules[0].id, 'mexico-first');
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
