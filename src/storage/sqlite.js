// SQLite driver: local trials and self-hosting. Synchronous (node:sqlite), so a whole ingest or report runs
// without yielding. Opens single-site databases from before sites existed and moves their data to site "default".
import { DatabaseSync } from 'node:sqlite';

// Version 1 is the single-site schema, kept as it was so old databases and new ones take the same path.
const V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  agent TEXT, vendor TEXT, kind TEXT, ip TEXT, ua TEXT, origin TEXT, intents TEXT,
  handoff_at INTEGER, handoff_referer TEXT, converted_at INTEGER, conversion_value REAL
);
CREATE INDEX IF NOT EXISTS sessions_merge ON sessions (ip, agent, last_seen);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, code TEXT, type TEXT NOT NULL, actor TEXT,
  agent TEXT, vendor TEXT, ip TEXT, ua TEXT, method TEXT, path TEXT, query TEXT, status INTEGER, title TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS events_code ON events (code, ts);
CREATE INDEX IF NOT EXISTS events_type ON events (type, ts);
CREATE TABLE IF NOT EXISTS exposures (
  code TEXT NOT NULL, rule TEXT NOT NULL, arm TEXT NOT NULL, eligible INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (code, rule)
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run INTEGER NOT NULL, ts INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT,
  question TEXT NOT NULL, answer TEXT, stop_reason TEXT, error TEXT, verdicts TEXT
);
CREATE INDEX IF NOT EXISTS answers_run ON answers (run, id);
`;

// Version 2: tenants, and site_id on every data table (part of each primary key, first in each index).
const V2 = `
CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sites (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs (id), name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX sites_org ON sites (org_id);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites (id), hash TEXT NOT NULL UNIQUE, hint TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
);
CREATE INDEX api_keys_site ON api_keys (site_id);
CREATE TABLE site_configs (
  site_id TEXT NOT NULL REFERENCES sites (id), version INTEGER NOT NULL, config TEXT NOT NULL, source TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (site_id, version)
);

DROP INDEX IF EXISTS sessions_merge; DROP INDEX IF EXISTS events_code; DROP INDEX IF EXISTS events_type; DROP INDEX IF EXISTS answers_run;
ALTER TABLE sessions RENAME TO sessions_v1; ALTER TABLE events RENAME TO events_v1;
ALTER TABLE exposures RENAME TO exposures_v1; ALTER TABLE answers RENAME TO answers_v1;

CREATE TABLE sessions (
  site_id TEXT NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  agent TEXT, vendor TEXT, kind TEXT, ip TEXT, ua TEXT,
  origin TEXT,               -- minted | resumed | shadow
  intents TEXT,              -- JSON, latest scored intents
  handoff_at INTEGER, handoff_referer TEXT, converted_at INTEGER, conversion_value REAL,
  PRIMARY KEY (site_id, code)
);
CREATE INDEX sessions_merge ON sessions (site_id, ip, agent, last_seen);
CREATE INDEX sessions_created ON sessions (site_id, created_at);
CREATE INDEX sessions_last_seen ON sessions (site_id, last_seen);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL, ts INTEGER NOT NULL,
  code TEXT,                 -- null for bots that get no session
  type TEXT NOT NULL,        -- fetch | rescue | not_found | handoff | link_check | shared | conversion | bot | error
  actor TEXT,                -- agent | human | bot | server
  agent TEXT, vendor TEXT, ip TEXT, ua TEXT, method TEXT, path TEXT, query TEXT, status INTEGER, title TEXT,
  data TEXT                  -- JSON
);
CREATE INDEX events_code ON events (site_id, code, ts);
CREATE INDEX events_ts ON events (site_id, ts);
CREATE INDEX events_type ON events (site_id, type, ts);
CREATE TABLE exposures (
  site_id TEXT NOT NULL, code TEXT NOT NULL, rule TEXT NOT NULL, arm TEXT NOT NULL, eligible INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (site_id, code, rule)
);
CREATE INDEX exposures_ts ON exposures (site_id, ts);
CREATE TABLE answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT NOT NULL,
  run INTEGER NOT NULL,      -- start time of the check run
  ts INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT, question TEXT NOT NULL,
  answer TEXT, stop_reason TEXT, error TEXT,
  verdicts TEXT              -- JSON [{ factId, verdict: correct | wrong | missing, quote }]
);
CREATE INDEX answers_run ON answers (site_id, run, id);

INSERT INTO sessions SELECT 'default', code, created_at, last_seen, agent, vendor, kind, ip, ua, origin, intents,
  handoff_at, handoff_referer, converted_at, conversion_value FROM sessions_v1;
INSERT INTO events (id, site_id, ts, code, type, actor, agent, vendor, ip, ua, method, path, query, status, title, data)
  SELECT id, 'default', ts, code, type, actor, agent, vendor, ip, ua, method, path, query, status, title, data FROM events_v1;
INSERT INTO exposures SELECT 'default', code, rule, arm, eligible, ts FROM exposures_v1;
INSERT INTO answers (id, site_id, run, ts, engine, model, question, answer, stop_reason, error, verdicts)
  SELECT id, 'default', run, ts, engine, model, question, answer, stop_reason, error, verdicts FROM answers_v1;
`;

export const MIGRATIONS = [
  { version: 1, up: (d) => d.exec(V1) },
  {
    version: 2,
    up(d, now) {
      const legacy = d.get(`SELECT (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM answers) AS n`).n;
      d.exec(V2);
      d.exec('DROP TABLE sessions_v1; DROP TABLE events_v1; DROP TABLE exposures_v1; DROP TABLE answers_v1;');
      if (legacy) {
        // Data from a single-site collector belongs to site "default"; its config arrives on the next start with --config.
        d.run("INSERT INTO orgs (id, name, created_at) VALUES ('default', 'Default', ?)", [now()]);
        d.run("INSERT INTO sites (id, org_id, name, created_at) VALUES ('default', 'default', 'Default site', ?)", [now()]);
      }
    },
  },
];

export function openSqlite(path = ':memory:', { now = () => Date.now() } = {}) {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const statements = new Map();
  const prep = (sql) => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  const driver = {
    dialect: 'sqlite',
    raw,
    all: (sql, params = []) => prep(sql).all(...params),
    get: (sql, params = []) => prep(sql).get(...params),
    run: (sql, params = []) => { prep(sql).run(...params); },
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
  migrate(driver, now);
  return driver;
}

function migrate(d, now) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS) {
    if (d.get('SELECT version FROM schema_migrations WHERE version = ?', [m.version])) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      m.up(d, now);
      d.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, now()]);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}
