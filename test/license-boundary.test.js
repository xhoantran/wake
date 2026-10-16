// The Apache-2.0 core must work without Wake Enterprise: nothing outside ee/ may import from ee/,
// except the CLI, which loads ee/ only for the enterprise commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function files(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules').flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

test('core code never imports Wake Enterprise', () => {
  for (const f of [...files('src'), ...files('adapters'), ...files('scripts'), ...files('examples')]) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/(?:from\s*|import\(\s*)['"][^'"]*\bee\//.test(src), `${f} imports from ee/`);
  }
});

test('every ee/ source file carries the enterprise license header', () => {
  for (const f of files('ee').filter((x) => !x.includes(`${path.sep}test${path.sep}`))) {
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').slice(0, 200);
    assert.match(head, /Wake Enterprise\. Licensed under ee\/LICENSE/, f);
  }
});
