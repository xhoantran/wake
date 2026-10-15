// Reports for one site. They read through the site-scoped store (src/storage/sql.js), so one site's dashboard
// cannot see another's data.
import { buildBrief } from './brief.js';
import { flowed } from './flow.js';

const AI_HOSTS = /chatgpt\.com|openai\.com|claude\.ai|perplexity\.ai|gemini\.google|copilot\.microsoft|meta\.ai|chat\.mistral/i;
const SEARCH_HOSTS = /google\.|bing\.com|duckduckgo\.com|yahoo\.|baidu\.|yandex\./i;

/** What a tag-based analytics tool would have credited this visit to. */
export function analyticsLabel(referer) {
  if (!referer) return 'Direct';
  if (AI_HOSTS.test(referer)) return 'AI referral';
  if (SEARCH_HOSTS.test(referer)) return 'Organic search';
  return 'Referral';
}

function rate(n, d) { return d ? n / d : 0; }

/** Difference in two proportions with a normal-approximation 95% interval. */
export function compare(a, b) {
  const p1 = rate(a.k, a.n), p2 = rate(b.k, b.n);
  const diff = p1 - p2;
  const se = Math.sqrt((a.n ? (p1 * (1 - p1)) / a.n : 0) + (b.n ? (p2 * (1 - p2)) / b.n : 0));
  return { routed: p1, holdout: p2, diff, low: diff - 1.96 * se, high: diff + 1.96 * se, enough: a.n >= 30 && b.n >= 30 };
}

/** The dashboard overview for one site. A value with a SQLite store, a promise with Postgres. */
export const overview = flowed(overviewOf);

function* overviewOf(store, config, { since = 0 } = {}) {
  const sessions = yield store.sessionsSince(since);
  const reads = yield store.agentReadCounts(since);
  const readsBy = new Map(reads.map((r) => [r.code, Number(r.n)]));
  const linkReached = new Set(yield store.codesThatReachedLinks(since));

  const total = sessions.length;
  const handoffs = sessions.filter((s) => s.handoff_at).length;
  const converted = sessions.filter((s) => s.converted_at);
  const value = converted.reduce((a, s) => a + (s.conversion_value || 0), 0);
  const botRequests = Number(yield store.botRequests(since));
  const agentReads = reads.reduce((a, r) => a + Number(r.n), 0);

  const funnel = [
    { step: 'Agent sessions', n: total },
    { step: 'Read 2+ pages', n: sessions.filter((s) => (readsBy.get(s.code) || 0) >= 2).length },
    { step: 'Reached a sign-up link', n: sessions.filter((s) => linkReached.has(s.code) || s.handoff_at).length },
    { step: 'A person took over', n: handoffs },
    { step: 'Converted', n: converted.length },
  ];

  const byAgent = new Map();
  for (const s of sessions) {
    const k = s.agent || 'Unknown';
    const a = byAgent.get(k) || { agent: k, vendor: s.vendor, sessions: 0, handoffs: 0, conversions: 0 };
    a.sessions++; if (s.handoff_at) a.handoffs++; if (s.converted_at) a.conversions++;
    byAgent.set(k, a);
  }

  const intentRows = new Map();
  for (const s of sessions) {
    const strong = s.intents.filter((i) => i.score >= config.minIntentScore);
    const ids = strong.length ? strong.map((i) => i.id) : ['_unclear'];
    for (const id of ids) {
      const label = id === '_unclear' ? 'Unclear yet' : strong.find((i) => i.id === id).label;
      const r = intentRows.get(id) || { id, label, sessions: 0, handoffs: 0, conversions: 0 };
      r.sessions++; if (s.handoff_at) r.handoffs++; if (s.converted_at) r.conversions++;
      intentRows.set(id, r);
    }
  }

  const exp = (yield store.exposureArms(since)).map((e) => ({ ...e, n: Number(e.n), handoffs: Number(e.handoffs), conversions: Number(e.conversions) }));
  const experiments = config.rules.map((r) => {
    const arm = (name) => exp.find((e) => e.rule === r.id && e.arm === name) || { n: 0, handoffs: 0, conversions: 0 };
    const routed = arm('routed'), holdout = arm('holdout');
    return {
      id: r.id, promote: r.promote, label: config.blocks[r.promote] || r.promote, holdoutShare: r.holdout,
      routed, holdout,
      handoff: compare({ n: routed.n, k: routed.handoffs }, { n: holdout.n, k: holdout.handoffs }),
      conversion: compare({ n: routed.n, k: routed.conversions }, { n: holdout.n, k: holdout.conversions }),
    };
  });

  const guessed = (yield store.guessedPaths(since))
    .map((g) => ({ path: g.path, sessions: Number(g.sessions), rescuedTo: Number(g.rescued) ? JSON.parse(g.data || '{}').to : null }));

  const questions = (yield store.topQuestions(since)).map((q) => ({ query: q.query, sessions: Number(q.sessions) }));

  const attribution = new Map();
  for (const s of converted) {
    const label = s.handoff_at ? analyticsLabel(s.handoff_referer) : 'Agent finished it';
    const a = attribution.get(label) || { label, conversions: 0, value: 0 };
    a.conversions++; a.value += s.conversion_value || 0;
    attribution.set(label, a);
  }

  return {
    site: config.name || (config.publicOrigin || config.upstream ? new URL(config.publicOrigin || config.upstream).host : 'Your site'),
    generatedAt: Date.now(),
    kpis: { sessions: total, agentReads, handoffs, conversions: converted.length, value, botRequests },
    funnel,
    agents: [...byAgent.values()].sort((a, b) => b.sessions - a.sessions),
    intents: [...intentRows.values()].sort((a, b) => b.sessions - a.sessions),
    experiments, guessed, questions,
    answers: yield* answerReportOf(store, config, experiments),
    attribution: [...attribution.values()].sort((a, b) => b.conversions - a.conversions),
  };
}

/**
 * The latest answer-check run: how often each fact came back correct, wrong or missing, and every wrong claim.
 * Facts that name blocks link to the rules promoting those blocks and their holdout results, so a wrong answer points at a fix.
 */
export const answerReport = flowed(answerReportOf);

function* answerReportOf(store, config, experiments) {
  const run = yield store.latestAnswerRun();
  if (!run) return null;
  const rows = yield store.answers(run);
  const fixes = (fact) => fact.blocks.map((block) => ({
    block, label: config.blocks[block] || null,
    rules: experiments.filter((e) => e.promote === block),
  }));
  const facts = config.answerChecks.facts.map((f) => ({ id: f.id, claim: f.claim, truth: f.truth, correct: 0, wrong: 0, missing: 0, fixes: fixes(f), claims: [] }));
  const byId = new Map(facts.map((f) => [f.id, f]));
  for (const a of rows) {
    for (const v of a.verdicts) {
      const f = byId.get(v.factId);
      if (!f) continue; // fact removed from the config since this run
      f[v.verdict]++;
      if (v.verdict === 'wrong') f.claims.push({ engine: a.engine, model: a.model, question: a.question, quote: v.quote, answerId: Number(a.id) });
    }
  }
  return {
    run: Number(run), finishedAt: Math.max(...rows.map((a) => Number(a.ts))),
    engines: [...new Set(rows.map((a) => a.engine))],
    questions: new Set(rows.map((a) => a.question)).size,
    answers: rows.length,
    errors: rows.filter((a) => a.error).map((a) => ({ engine: a.engine, question: a.question, error: a.error })),
    wrong: facts.reduce((n, f) => n + f.wrong, 0),
    facts: facts.sort((a, b) => b.wrong - a.wrong || a.correct - b.correct),
  };
}

export const listAnswers = flowed(function* (store, { run } = {}) {
  run = run || (yield store.latestAnswerRun());
  return run ? yield store.answers(run) : [];
});

export const listSessions = flowed(function* (store, { limit = 100 } = {}) {
  const rows = yield store.recentSessions(limit);
  return rows.map((s) => ({ code: s.code, agent: s.agent, vendor: s.vendor, createdAt: s.created_at, lastSeen: s.last_seen, origin: s.origin,
    reads: Number(s.reads), topIntent: s.intents[0]?.label || null, handoffAt: s.handoff_at, convertedAt: s.converted_at, value: s.conversion_value }));
});

export const sessionDetail = flowed(function* (store, config, code) {
  const session = yield store.getSession(code);
  if (!session) return null;
  const events = yield store.events(code);
  const exposures = yield store.exposures(code);
  return { session, events, exposures, brief: buildBrief(session, events, config) };
});
