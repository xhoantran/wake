// Answer checks: ask AI assistants the questions people ask about the site, then judge each answer against the facts.
//
// An engine is { id, ask(prompt, { question, site }) -> { text, model?, stopReason? } }.
// A judge is { judge({ question, answer, facts, site }) -> [{ factId, verdict, quote }] }.
// Config entries are either such objects (anything with ask / judge) or { type, ...options } for a registered type.
import { then } from './flow.js';

export const VERDICTS = ['correct', 'wrong', 'missing'];
const API = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_MODEL = 'claude-opus-5-5';

const ENGINE_TYPES = { claude: claudeEngine };
const JUDGE_TYPES = { claude: claudeJudge };

/** Add a provider: registerEngine('acme', (options) => ({ id: 'acme', ask })). */
export function registerEngine(type, factory) { ENGINE_TYPES[type] = factory; }
export function registerJudge(type, factory) { JUDGE_TYPES[type] = factory; }

function resolve(spec, types, method, what) {
  if (typeof spec?.[method] === 'function') return spec;
  const make = types[spec?.type];
  if (!make) throw new Error(`wake: unknown ${what} type "${spec?.type}" (known: ${Object.keys(types).join(', ')})`);
  return make(spec);
}
export const resolveEngine = (spec) => resolve(spec, ENGINE_TYPES, 'ask', 'answer engine');
export const resolveJudge = (spec) => resolve(spec, JUDGE_TYPES, 'judge', 'judge');

/** One Messages API call over plain fetch (Wake has no dependencies). Retries 429, 529 and 5xx. */
async function callClaude(body, { apiKey, fetchImpl = globalThis.fetch, retries = 2 }) {
  if (!apiKey) throw new Error('wake: set ANTHROPIC_API_KEY to use the claude engine or judge');
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      // fallbacks: "default" re-runs a request the safety classifiers decline on Anthropic's recommended model.
      body: JSON.stringify({ fallbacks: 'default', ...body }),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (attempt < retries && (res.status === 429 || res.status >= 500)) {
      const after = Number(res.headers.get('retry-after') ?? NaN);
      const wait = Number.isFinite(after) ? after * 1000 : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/**
 * Claude as an assistant a person asks. With webSearch it may look things up, as the live product does;
 * without it, the answer shows what the model already believes about the site.
 */
export function claudeEngine({ id = 'claude', model = DEFAULT_MODEL, effort = 'medium', system, webSearch = false,
  apiKey = process.env.ANTHROPIC_API_KEY, fetch: fetchImpl } = {}) {
  return {
    id, model,
    async ask(prompt) {
      const messages = [{ role: 'user', content: prompt }];
      const body = { model, max_tokens: 16000, output_config: { effort }, messages };
      if (system) body.system = system;
      if (webSearch) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }];
      let msg;
      for (let turn = 0; turn < 4; turn++) {
        msg = await callClaude(body, { apiKey, fetchImpl });
        if (msg.stop_reason !== 'pause_turn') break;
        messages.push({ role: 'assistant', content: msg.content }); // server tool paused a long turn; let it continue
      }
      return { text: msg.stop_reason === 'refusal' ? '' : textOf(msg), model: msg.model, stopReason: msg.stop_reason };
    },
  };
}

export const JUDGE_SYSTEM = `You check what an AI assistant told a person about a company against the company's verified facts.
For every fact you are given, return one verdict:
- "correct": the answer states the fact in a way consistent with the truth.
- "wrong": the answer says something that contradicts the truth (a wrong price, a wrong inclusion or exclusion, a made-up policy or step).
- "missing": the answer does not address the fact.
Judge only against the truth you are given, not your own knowledge of the company.
For "correct" and "wrong", quote the sentence from the answer that the verdict rests on, verbatim and at most 300 characters. For "missing", the quote is an empty string.`;

export function judgePrompt({ question, answer, facts, site }) {
  return `Company: ${site}\n\nThe person asked:\n${question}\n\nThe assistant answered:\n<answer>\n${answer}\n</answer>\n\nFacts:\n`
    + facts.map((f) => `- id: ${f.id}\n  claim: ${f.claim}\n  truth: ${f.truth}`).join('\n');
}

/** Claude as the judge, with the verdicts constrained to a JSON schema. */
export function claudeJudge({ model = DEFAULT_MODEL, effort = 'high', apiKey = process.env.ANTHROPIC_API_KEY, fetch: fetchImpl } = {}) {
  return {
    model,
    async judge(input) {
      const schema = {
        type: 'object',
        properties: {
          verdicts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                factId: { type: 'string', enum: input.facts.map((f) => f.id) },
                verdict: { type: 'string', enum: VERDICTS },
                quote: { type: 'string' },
              },
              required: ['factId', 'verdict', 'quote'],
              additionalProperties: false,
            },
          },
        },
        required: ['verdicts'],
        additionalProperties: false,
      };
      const msg = await callClaude({
        model, max_tokens: 16000, system: JUDGE_SYSTEM,
        output_config: { effort, format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: judgePrompt(input) }],
      }, { apiKey, fetchImpl });
      if (msg.stop_reason === 'refusal') throw new Error('judge declined to answer');
      return JSON.parse(textOf(msg)).verdicts;
    },
  };
}

/** Keep one well-formed verdict per known fact; facts the judge skipped count as missing. */
export function cleanVerdicts(raw, facts) {
  const byId = new Map();
  for (const v of Array.isArray(raw) ? raw : []) {
    if (!v || byId.has(v.factId) || !facts.some((f) => f.id === v.factId) || !VERDICTS.includes(v.verdict)) continue;
    byId.set(v.factId, { factId: v.factId, verdict: v.verdict, quote: v.verdict === 'missing' ? '' : String(v.quote || '').slice(0, 500) });
  }
  return facts.map((f) => byId.get(f.id) || { factId: f.id, verdict: 'missing', quote: '' });
}

export function siteName(config) {
  return config.answerChecks.site || config.name || (config.publicOrigin || config.upstream ? new URL(config.publicOrigin || config.upstream).host : 'this company');
}

/** The questions to ask: the configured ones, or the top questions agents searched for. A promise with Postgres. */
export function checkQuestions(store, config) {
  const ac = config.answerChecks;
  if (ac.questions.length) return ac.questions.slice(0, ac.maxQuestions);
  return then(store.topQuestions(0, ac.maxQuestions), (rows) => rows.map((q) => q.query));
}

/**
 * Ask every question of every engine, judge each answer and store it.
 * config must be normalized (normalizeConfig). engines / judge override the config, e.g. with fakes in tests.
 */
export async function runChecks({ config, store, engines, judge, questions, now = () => Date.now(), concurrency = 4, log = () => {} }) {
  const ac = config.answerChecks;
  if (!ac.facts.length) throw new Error('wake: answerChecks.facts is empty; add the facts to check answers against');
  const qs = questions || await checkQuestions(store, config);
  if (!qs.length) throw new Error('wake: no questions to ask; set answerChecks.questions or let Wake capture some agent searches first');
  const eng = (engines || ac.engines).map(resolveEngine);
  const jdg = resolveJudge(judge || ac.judge);
  const site = siteName(config);
  const run = now();

  const jobs = qs.flatMap((question) => eng.map((engine) => ({ question, engine })));
  const summary = { run, questions: qs.length, engines: eng.map((e) => e.id), answers: 0, errors: 0, correct: 0, wrong: 0, missing: 0 };
  const next = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const { question, engine } = job;
      const row = { run, engine: engine.id, model: engine.model, question, verdicts: [] };
      try {
        const prompt = `${question}\n\n(This is about ${site}.)`;
        const a = await engine.ask(prompt, { question, site });
        Object.assign(row, { answer: a.text, model: a.model || engine.model, stopReason: a.stopReason });
        if (a.text) row.verdicts = cleanVerdicts(await jdg.judge({ question, answer: a.text, facts: ac.facts, site }), ac.facts);
        else row.error = a.stopReason === 'refusal' ? 'The assistant declined to answer' : 'Empty answer';
      } catch (err) {
        row.error = err.message;
      }
      row.ts = now();
      await store.addAnswer(row);
      summary.answers++;
      if (row.error) summary.errors++;
      for (const v of row.verdicts) summary[v.verdict]++;
      log(`${engine.id} · ${question} · ${row.error || row.verdicts.filter((v) => v.verdict === 'wrong').length + ' wrong'}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, next));
  return summary;
}
