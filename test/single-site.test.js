// The single-site collector keeps its data when it moves to the site-aware storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import baseConfig from '../examples/meridian/wake.config.js';
import { openStore } from '../src/store.js';
import { createCollector } from '../src/collector.js';

test('a single-site SQLite database from before sites existed opens as site "default"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-legacy-'));
  const file = path.join(dir, 'collector.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sessions (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, agent TEXT, vendor TEXT, kind TEXT,
      ip TEXT, ua TEXT, origin TEXT, intents TEXT, handoff_at INTEGER, handoff_referer TEXT, converted_at INTEGER, conversion_value REAL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, code TEXT, type TEXT NOT NULL, actor TEXT, agent TEXT, vendor TEXT,
      ip TEXT, ua TEXT, method TEXT, path TEXT, query TEXT, status INTEGER, title TEXT, data TEXT);
    CREATE TABLE exposures (code TEXT NOT NULL, rule TEXT NOT NULL, arm TEXT NOT NULL, eligible INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (code, rule));
    CREATE TABLE answers (id INTEGER PRIMARY KEY AUTOINCREMENT, run INTEGER NOT NULL, ts INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT,
      question TEXT NOT NULL, answer TEXT, stop_reason TEXT, error TEXT, verdicts TEXT);
    INSERT INTO sessions VALUES ('MW-OLD001', 1000, 2000, 'ChatGPT-User', 'OpenAI', 'live', 'ip', 'ua', 'minted', '[]', NULL, NULL, 3000, 120);
    INSERT INTO events (ts, code, type, actor, path, status) VALUES (1000, 'MW-OLD001', 'fetch', 'agent', '/plans/family', 200);
    INSERT INTO exposures VALUES ('MW-OLD001', 'mexico-first', 'routed', 1, 1000);`);
  old.close();

  const store = openStore(file);
  assert.equal(store.getSession('MW-OLD001').conversion_value, 120);
  assert.equal(store.events('MW-OLD001')[0].path, '/plans/family');
  const collector = createCollector({ config: structuredClone(baseConfig), store, apiKeys: ['wk_old_key'] });
  const r = await collector.handle(new Request('http://c/v1/config', { headers: { authorization: 'Bearer wk_old_key' } }), { ip: '8.8.8.8' });
  assert.equal((await r.json()).version, 1, 'the config file became version 1 of site "default"');
  const o = await (await collector.handle(new Request('http://c/_wake/api/overview'), { ip: '127.0.0.1' })).json();
  assert.equal(o.kpis.sessions, 1);
  assert.equal(o.experiments.find((e) => e.id === 'mexico-first').routed.n, 1);

  // Restarting with an edited file adds a version; a dashboard edit is kept over the file.
  const edited = { ...structuredClone(baseConfig), mode: 'route' };
  assert.equal(createCollector({ config: edited, store, apiKeys: [] }).siteConfig().version, 2);
  await collector.configs.saveConfig('default', { ...edited, mode: 'shadow' }, { source: 'dashboard' });
  const logs = [];
  const again = createCollector({ config: edited, store, log: (l) => logs.push(l) });
  assert.equal(again.siteConfig().config.mode, 'shadow');
  assert.match(logs[0], /config file is not applied/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
