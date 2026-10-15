// The storage interface. Both databases run the same SQL ("?" placeholders, written to work on SQLite and
// Postgres); a driver supplies all / get / run, synchronous for SQLite and returning promises for Postgres.
// Session data is only reachable through siteStore(db, siteId), which puts site_id into every query.
import { flowed, then } from '../flow.js';

const parseSession = (row) => row && { ...row, intents: JSON.parse(row.intents || '[]') };
const parseEvent = (r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null });

/** Session, event, exposure and answer data for one site. */
export function siteStore(db, siteId) {
  if (!siteId) throw new Error('wake: siteStore needs a site id');
  const S = siteId;
  return {
    siteId,
    getSession: (code) => then(db.get('SELECT * FROM sessions WHERE site_id = ? AND code = ?', [S, code]), parseSession),
    /** Create a session, or return the existing one if another writer created it first. */
    createSession: flowed(function* ({ code, ts, agent, ip, ua, origin }) {
      yield db.run(`INSERT INTO sessions (site_id, code, created_at, last_seen, agent, vendor, kind, ip, ua, origin, intents)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]') ON CONFLICT DO NOTHING`,
      [S, code, ts, ts, agent?.name ?? null, agent?.vendor ?? null, agent?.kind ?? null, ip ?? null, ua ?? null, origin]);
      return parseSession(yield db.get('SELECT * FROM sessions WHERE site_id = ? AND code = ?', [S, code]));
    }),
    touch: (code, ts) => db.run('UPDATE sessions SET last_seen = ? WHERE site_id = ? AND code = ? AND last_seen < ?', [ts, S, code, ts]),
    setIntents: (code, intents) => db.run('UPDATE sessions SET intents = ? WHERE site_id = ? AND code = ?', [JSON.stringify(intents), S, code]),
    findMergeCandidate: (ip, agentName, ua, since) => then(db.get(`SELECT * FROM sessions
        WHERE site_id = ? AND ip = ? AND agent = ? AND ua = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 1`,
    [S, ip ?? null, agentName ?? null, ua ?? null, since]), parseSession),
    markHandoff: (code, ts, referer) => db.run(`UPDATE sessions SET handoff_at = COALESCE(handoff_at, ?),
        handoff_referer = COALESCE(handoff_referer, ?) WHERE site_id = ? AND code = ?`, [ts, referer ?? '', S, code]),
    markConversion: (code, ts, value) => db.run(`UPDATE sessions SET converted_at = COALESCE(converted_at, ?),
        conversion_value = COALESCE(conversion_value, 0) + ? WHERE site_id = ? AND code = ?`, [ts, value || 0, S, code]),
    addEvent: (e) => db.run(`INSERT INTO events (site_id, ts, code, type, actor, agent, vendor, ip, ua, method, path, query, status, title, data)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [S, e.ts, e.code ?? null, e.type, e.actor ?? null, e.agent ?? null, e.vendor ?? null, e.ip ?? null, e.ua ?? null,
      e.method ?? null, e.path ?? null, e.query ?? null, e.status ?? null, e.title ?? null, e.data ? JSON.stringify(e.data) : null]),
    events: (code) => then(db.all('SELECT * FROM events WHERE site_id = ? AND code = ? ORDER BY ts, id', [S, code]), (rows) => rows.map(parseEvent)),
    recordExposure: (code, rule, arm, eligible, ts) => db.run(`INSERT INTO exposures (site_id, code, rule, arm, eligible, ts)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, [S, code, rule, arm, eligible ? 1 : 0, ts]),
    exposures: (code) => db.all('SELECT rule, arm, eligible, ts FROM exposures WHERE site_id = ? AND code = ?', [S, code]),
    deleteSession: (code) => db.run('DELETE FROM sessions WHERE site_id = ? AND code = ?', [S, code]),
    addAnswer: (a) => db.run(`INSERT INTO answers (site_id, run, ts, engine, model, question, answer, stop_reason, error, verdicts)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [S, a.run, a.ts, a.engine, a.model ?? null, a.question, a.answer ?? null, a.stopReason ?? null, a.error ?? null, JSON.stringify(a.verdicts || [])]),
    answers: (run) => then(db.all('SELECT * FROM answers WHERE site_id = ? AND run = ? ORDER BY id', [S, run]),
      (rows) => rows.map((r) => ({ ...r, verdicts: JSON.parse(r.verdicts || '[]') }))),
    latestAnswerRun: () => then(db.get('SELECT MAX(run) AS run FROM answers WHERE site_id = ?', [S]), (r) => r?.run ?? null),
    knownPaths: () => then(db.all(`SELECT DISTINCT path FROM events
        WHERE site_id = ? AND type = 'fetch' AND status = 200 AND path IS NOT NULL LIMIT 5000`, [S]), (rows) => rows.map((r) => r.path)),

    // Report queries (src/reports.js turns these into the dashboard).
    sessionsSince: (since) => then(db.all('SELECT * FROM sessions WHERE site_id = ? AND created_at >= ?', [S, since]), (rows) => rows.map(parseSession)),
    agentReadCounts: (since) => db.all(`SELECT code, COUNT(*) AS n FROM events
        WHERE site_id = ? AND type = 'fetch' AND actor = 'agent' AND ts >= ? GROUP BY code`, [S, since]),
    codesThatReachedLinks: (since) => then(db.all(`SELECT DISTINCT code FROM events
        WHERE site_id = ? AND type IN ('link_check', 'handoff', 'shared') AND ts >= ?`, [S, since]), (rows) => rows.map((r) => r.code)),
    botRequests: (since) => then(db.get(`SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND type = 'bot' AND ts >= ?`, [S, since]), (r) => r.n),
    exposureArms: (since) => db.all(`SELECT x.rule, x.arm, COUNT(*) AS n,
        SUM(CASE WHEN s.handoff_at IS NOT NULL THEN 1 ELSE 0 END) AS handoffs,
        SUM(CASE WHEN s.converted_at IS NOT NULL THEN 1 ELSE 0 END) AS conversions
      FROM exposures x JOIN sessions s ON s.site_id = x.site_id AND s.code = x.code
      WHERE x.site_id = ? AND x.eligible = 1 AND x.ts >= ? GROUP BY x.rule, x.arm`, [S, since]),
    guessedPaths: (since) => db.all(`SELECT path, COUNT(DISTINCT code) AS sessions,
        SUM(CASE WHEN type = 'rescue' THEN 1 ELSE 0 END) AS rescued, MAX(data) AS data
      FROM events WHERE site_id = ? AND type IN ('rescue', 'not_found') AND ts >= ?
      GROUP BY path ORDER BY sessions DESC LIMIT 25`, [S, since]),
    topQuestions: (since, limit = 20) => db.all(`SELECT query, COUNT(DISTINCT code) AS sessions FROM events
        WHERE site_id = ? AND query IS NOT NULL AND ts >= ? GROUP BY query ORDER BY sessions DESC LIMIT ?`, [S, since, limit]),
    recentSessions: (limit) => then(db.all(`SELECT s.*, (SELECT COUNT(*) FROM events e
          WHERE e.site_id = s.site_id AND e.code = s.code AND e.type = 'fetch' AND e.actor = 'agent') AS reads
        FROM sessions s WHERE s.site_id = ? ORDER BY s.last_seen DESC LIMIT ?`, [S, limit]), (rows) => rows.map(parseSession)),
  };
}

/** Organizations, sites, API keys (stored as SHA-256 hashes) and versioned site configs. */
export function tenantStore(db) {
  return {
    createOrg: ({ id, name, ts }) => db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', [id, name, ts]),
    getOrg: (id) => db.get('SELECT * FROM orgs WHERE id = ?', [id]),
    createSite: ({ id, orgId, name, ts }) => db.run('INSERT INTO sites (id, org_id, name, created_at) VALUES (?, ?, ?, ?)', [id, orgId, name, ts]),
    getSite: (id) => db.get('SELECT * FROM sites WHERE id = ?', [id]),
    listSites: (orgId) => (orgId
      ? db.all('SELECT * FROM sites WHERE org_id = ? ORDER BY created_at, id', [orgId])
      : db.all('SELECT * FROM sites ORDER BY created_at, id', [])),
    addKey: ({ id, siteId, hash, hint, ts, expiresAt = null }) => db.run(`INSERT INTO api_keys (id, site_id, hash, hint, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [id, siteId, hash, hint, ts, expiresAt]),
    keyByHash: (hash) => db.get('SELECT * FROM api_keys WHERE hash = ?', [hash]),
    getKey: (id) => db.get('SELECT * FROM api_keys WHERE id = ?', [id]),
    listKeys: (siteId) => db.all('SELECT id, site_id, hint, created_at, expires_at, revoked_at FROM api_keys WHERE site_id = ? ORDER BY created_at, id', [siteId]),
    /** Let every other live key of the site run out at `at` (rotation with a grace period). */
    expireOtherKeys: (siteId, keepId, at) => db.run(`UPDATE api_keys SET expires_at = ?
        WHERE site_id = ? AND id <> ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, [at, siteId, keepId, at]),
    revokeKey: (id, ts) => db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', [ts, id]),
    latestConfig: (siteId) => db.get('SELECT * FROM site_configs WHERE site_id = ? ORDER BY version DESC LIMIT 1', [siteId]),
    getConfigVersion: (siteId, version) => db.get('SELECT * FROM site_configs WHERE site_id = ? AND version = ?', [siteId, version]),
    configHistory: (siteId, limit = 20) => db.all(`SELECT version, source, created_at FROM site_configs
        WHERE site_id = ? ORDER BY version DESC LIMIT ?`, [siteId, limit]),
    /** Fails on a duplicate (site_id, version): two saves from the same base version cannot both win. */
    insertConfig: ({ siteId, version, config, source, ts }) => db.run(`INSERT INTO site_configs (site_id, version, config, source, created_at)
        VALUES (?, ?, ?, ?, ?)`, [siteId, version, config, source, ts]),
  };
}

/** Tables copied by `wake admin copy`, parents first. */
export const TABLES = ['orgs', 'sites', 'api_keys', 'site_configs', 'sessions', 'events', 'exposures', 'answers'];
