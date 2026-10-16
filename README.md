# Wake

Wake follows AI agents (ChatGPT, Claude, Perplexity and others) through your website, one conversation at a time, and connects what they read to what the person does next.

It works like Datadog: a small SDK runs **inside the customer's stack** (their Node app, their Next.js middleware, or a Worker in their own Cloudflare account), and our **collector** receives events and runs the dashboard.

When a live agent fetches a page, the SDK gives the visit a session code and rewrites the page's links to carry it (`/a/MW-7K2Q9P.3/plans/family`). Every later read from that conversation lands in the same session. Sign-up links become hand-off links (`/r/MW-7K2Q9P.3/signup`), so when a person opens the link the agent gave them, the order is credited to the agent session.

The SDK has no dependencies and uses only web-standard `Request`/`Response`. The collector needs Node 22.5 or later (it uses the built-in SQLite); the hosted collector on Postgres also needs the `pg` package.

## How it stays out of the customer's uptime

```
 visitor ──> customer's CDN / app ──────────────> page
               │  Wake SDK (local)                  ▲
               │  - decides from the URL token       │ agent pages rewritten,
               │    and a cached config              │ everything else untouched
               │  - no network call while serving    │
               └── events, batched, after the response ──> Wake collector ──> dashboard
                                                            (ours; if it is down,
                                                             events are dropped, pages are not)
```

- **Decisions are local.** Rules, intents and holdout splits come from a cached config. Session state travels in the URL token: after the dot is one base-36 digit per intent (`.30a1`), so the next read knows what the session did without a lookup.
- **Telemetry is fire-and-forget.** Events are batched and sent after the response (`waitUntil` on edge platforms). If the collector is unreachable, they are dropped and counted.
- **Only live agents are touched.** People and search engines pass through with no extra work. Index and training crawlers are only counted.
- **Fails open.** Any error while rewriting returns the site's original response. Responses over `maxTransformBytes` pass through.
- **Kill switch.** `enabled: false` (or `WAKE_DISABLED=1` in a Worker) passes everything through, and old session URLs redirect to the clean page so no link breaks.
- **Three modes** that match how much the customer trusts it so far:
  - `shadow`: changes nothing. Reports which blocks each page has, and the collector works out which rules would have fired. Reads are grouped into sessions by hashed IP and user-agent.
  - `trace` (**the default**): sessions, link rewriting and hand-offs, so every agent journey and the conversions it leads to are tracked. Page content is never changed, and guessed URLs stay 404 (the likely page is still reported).
  - `route` (opt in): everything in `trace`, plus content rules with holdouts, redirects for guessed URLs, and the research brief if `brief.enabled` is set.

  Start with `trace` (or `shadow`), read the data, and only then turn on `route` for the rules you trust.
- **Privacy.** IPs are hashed before they leave the customer's stack. Search questions have emails, phone numbers and addresses removed.

## What it does

| Problem | What Wake does |
| --- | --- |
| Agent visits are invisible and unconnected | Groups each conversation's page reads into one session |
| You don't know why agents visit | Scores intents from the pages read and the site-search questions asked |
| You never see the shopper's question | Captures site-search queries and removes emails, phone numbers and addresses first |
| One static page for every agent | Rules move an existing block of the page to the top for sessions that match, so agents see the same facts as people |
| No way to tell if a change helped | Holds out a share of sessions at random for each rule and compares take-over and conversion rates |
| Agents guess URLs and hit 404s | Redirects to the closest real page, keeping the session, and lists guesses that had no match |
| Orders get credited to "Direct" | Joins the person who opens the agent's link to the agent session, and shows what tag-based analytics would have called it |
| Sales starts every conversation from scratch | Writes a brief per session: pages read, questions, likely needs, what to lead with |
| You don't know what assistants tell people about you | Asks assistants the questions agents searched for, judges each answer against your facts, and links every wrong claim to the rule that fixes it |

Search engines (Googlebot, Bingbot) and index and training crawlers never get session codes. A crawler that requests a session URL is redirected to the clean URL. The site's own canonical tags are left alone.

## Install (customer side)

Node (Express, Connect, plain `http`):

```js
import { wakeMiddleware } from 'wake/node-middleware';
app.use(wakeMiddleware({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.example' }));
```

Next.js (`middleware.ts`):

```js
import { NextResponse } from 'next/server';
import { wakeNext } from 'wake/next';
const wake = wakeNext({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.example' });
export async function middleware(request, event) {
  return (await wake(request, event)) ?? NextResponse.next();
}
// In an order handler: wake.conversion(request, { name: 'order', value: 120 })
```

Cloudflare Worker, in the customer's own account (see `adapters/wrangler.example.toml`):

```js
import { createWorker } from 'wake/worker';
export default createWorker(); // reads WAKE_API_KEY and WAKE_ENDPOINT
```

With only `apiKey` and `endpoint`, the SDK pulls its site's config from the collector (`GET /v1/config`) in the background, about once a minute, and keeps the last good copy. Until the first copy arrives, it passes everything through. You can also pass a local `config`.

## Try it locally

```bash
npm test                                   # 46 tests (WAKE_TEST_PG=postgres://… adds the hosted tests on Postgres)
PORT=4000 npm run example:site             # fictional example site
```

Everything in one process (proxy, collector and dashboard):

```bash
npm start -- --trust-proxy --db demo.db    # Wake in front of the site on :8787, dashboard at /_wake/
npm run simulate                           # 400 simulated agent sessions
```

Or as two processes, the way it runs for customers:

```bash
node bin/wake.js collector --config examples/meridian/wake.config.js --api-key wk_demo_123 --db collector.db   # :8790
node bin/wake.js proxy --config examples/meridian/wake.config.js --endpoint http://127.0.0.1:8790 --api-key wk_demo_123 --trust-proxy
npm run simulate
open http://127.0.0.1:8790/_wake/
```

Answer checks with two scripted sample assistants (no API key needed):

```bash
node bin/wake.js check --config examples/meridian/wake.config.js --db collector.db --engines examples/meridian/sample-engines.js
```

Put the proxy in front of any site:

```bash
WAKE_UPSTREAM=https://www.example.com node bin/wake.js --config examples/any-site.config.js --port 8788
curl -A "ChatGPT-User/1.0" http://127.0.0.1:8788/
```

## Config

A config is a plain object (a JS module for the CLI). It can live in the collector, which serves it to every SDK install, or be passed to the SDK directly. Only the proxy needs `upstream`. Keep it JSON-friendly (write `pathRewrites` patterns as strings) so the collector can serve it. See `src/config.js` for every option with its default, and `examples/meridian/wake.config.js` for a full example.

```js
export default {
  mode: 'trace',                                 // shadow | trace | route
  codePrefix: 'EX',
  handoffPaths: ['/signup', '/checkout/**'],     // links that become hand-off links
  intents: [{ id: 'pricing', label: 'Comparing prices', paths: ['/pricing'], keywords: ['price', 'cost'] }],
  blocks: { 'annual-discount': 'Annual plans are 20% cheaper.' },
  rules: [{ id: 'discount-first', when: { intents: ['pricing'], path: '/pricing' }, promote: 'annual-discount', holdout: 0.2 }],
  aliases: { '/plans': '/pricing' },             // exact redirects for guessed URLs
  synonyms: { cost: ['pricing'] },               // vocabulary for fuzzy redirects
  conversions: [{ name: 'signup', method: 'POST', path: '/api/signup' }],
  pathRewrites: [['^/a/NW-[A-Z0-9]+(?=/|$)', '']], // ignore a site's own path codes in analytics
  dashboard: { token: process.env.WAKE_TOKEN },  // without a token the dashboard only opens on localhost
};
```

Mark blocks that rules may move, in HTML or Markdown:

```html
<main>
  <!-- wake:lead -->            <!-- optional: where promoted blocks go; defaults to the top of <main> -->
  <h1>International Pass</h1>
  <p>$10 a day in 210 destinations.</p>
  <!-- wake:block mexico-included -->
  <section>Mexico and Canada are included on Unlimited Plus.</section>
  <!-- /wake:block -->
</main>
```

## Answer checks

`wake check` finds out what AI assistants tell people about the site and compares it with the truth. It asks each question of each configured assistant, has a judge compare every answer with your facts, and stores the results in the `answers` table. The dashboard panel "What agents say vs the truth" lists each wrong claim with the assistant, its exact words, the question and the true fact.

```js
answerChecks: {
  site: 'Example (example.com)',     // how the question names the site; defaults to `name` or the host
  questions: [],                     // empty: the top questions Wake has captured from agents (up to maxQuestions, default 10)
  facts: [
    { id: 'annual-discount', claim: 'Annual plans are cheaper',
      truth: 'Annual plans are 20% cheaper than monthly.', blocks: ['annual-discount'] },
  ],
  engines: [{ type: 'claude' }],     // the default
  judge: { type: 'claude' },         // the default
}
```

```bash
ANTHROPIC_API_KEY=… node bin/wake.js check --config wake.config.js --db wake.db
```

- **Linking to a fix.** When a fact names `blocks`, the panel shows which rule promotes each block and that rule's holdout result. A wrong answer then points to the page block that should be leading for those agents, and to whether leading with it helps. A block that no rule promotes yet is flagged.
- **Claude engine.** `{ type: 'claude', model, effort, system, webSearch }` calls the Messages API with `claude-opus-5-5` (effort `medium`) using the key in `ANTHROPIC_API_KEY`. By default it answers from what the model already knows. With `webSearch: true` it can look things up, as the consumer product does. Calls go over plain `fetch` so Wake stays dependency-free. They retry 429 and 5xx responses and set `fallbacks: "default"`, so a request the safety classifiers decline is re-run on another model.
- **Judge.** Claude (effort `high`) returns `{ factId, verdict: correct | wrong | missing, quote }` for every fact, constrained to a JSON schema. Wake drops unknown facts and verdicts, and counts facts the judge skipped as missing.
- **Other providers.** An engine is any object `{ id, ask(prompt, { question, site }) → { text, model? } }`, and a judge is any object `{ judge({ question, answer, facts, site }) → verdicts }`. Put one in the config directly, register a type with `registerEngine('acme', options => engine)`, or pass a module that exports `{ engines, judge }` with `--engines file.js`. `examples/meridian/sample-engines.js` is a working example.
- **Runs.** Each run is stored with its start time, and the dashboard shows the latest one. `GET /_wake/api/answers[?run=…]` returns every stored answer with its verdicts. A failed call is stored with its error and counted, and the run carries on.
- **Cost.** A run makes about two Claude calls per question per engine: one for the answer, one for the judge.

Conversions can come from a matched request (the response header `x-wake-value` sets the value), from `wake.conversion(request, { name, value })` in your own handler (it reads the hand-off cookie), or from your server: `POST /_wake/api/convert {"code": "...", "name": "order", "value": 120}`.

## Deploy the collector to Cloudflare

The hosted collector runs as a Cloudflare Worker with Postgres (for example Supabase) behind Hyperdrive. Customer sites never call it while serving a page: their SDK pushes batched events to it and pulls its config about once a minute.

```
visitors ─> customer's Cloudflare account: Wake SDK Worker ─> customer's site (unchanged)
                     │ events (batched, after the response) / config (cached)
                     ▼
            your Cloudflare account: collector Worker (ingest, config, dashboard, daily answer checks)
                     │ Hyperdrive (one client per request)
                     ▼
            Postgres (Supabase)
```

1. Apply the schema and create your first site. Any `wake admin` command against the database runs the migrations:
   ```bash
   node bin/wake.js admin org create --db "postgres://…" --id acme --name "Acme"
   node bin/wake.js admin site create --db "postgres://…" --org acme --name "Acme web" --config wake.config.js
   ```
   Use the database's direct connection string for these commands.
2. Create a Hyperdrive config for the same database and put its id in `deploy/cloudflare/wrangler.toml`:
   ```bash
   npx wrangler hyperdrive create wake-db --connection-string="postgres://…"
   ```
3. Set the secrets: `npx wrangler secret put WAKE_SECRET` (signs dashboard links), and optionally `ANTHROPIC_API_KEY` for the daily answer checks.
4. `npm run collector:deploy`, then point a custom domain such as `collector.example.com` at it.
5. Get a dashboard link: `node bin/wake.js admin token --db "postgres://…" --site SITE --secret … --url https://collector.example.com`.

Local development runs the Worker in the real Workers runtime against a local Postgres:

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@127.0.0.1:5432/wake" npm run collector:dev
```

The Worker never migrates the database, so a cold start never takes a lock. Each request opens one database client through Hyperdrive and closes it after the response; requests sharing an isolate keep separate clients.

## Collector API

- `POST /v1/events` with `Authorization: Bearer <api key>` and `{ "events": [...] }`. The key decides the site the events are written to. Returns `202 { accepted, ignored, rejected }`: only an agent's own read can start a session, so other events with an unknown code are ignored; events older than 7 days or dated in the future are rejected. `401` for an unknown, revoked or expired key, `413` over 1,000 events or 1 MB, `429` with `Retry-After` over the key's rate limit.
- `GET /v1/config`: the key's site config for SDKs, with its `version`, and without the dashboard token, answer-check settings or `upstream`. Sends an `ETag`; `If-None-Match` gets `304` while the version is unchanged.
- `/_wake/sites/<site>/`: one site's dashboard on a multi-site collector. `/_wake/` on a single-site collector. `GET /healthz` for uptime checks.

`createCollector({ storage, secret })` (multi-site) or `createCollector({ config, store, apiKeys })` (single site) returns `handle(request)` and `ingest(events, { siteId })` for embedding.

## Hosted collector

One collector process serves many customers. An organization owns sites; each site has its own API keys, a versioned config, its sessions and its dashboard.

```
organization ── site ─┬─ API keys          stored as SHA-256 hashes; rotate with a grace period
                      ├─ config v1, v2, …  edited in the dashboard, served to the site's SDKs at GET /v1/config
                      └─ sessions, events, holdout exposures, answer checks   (site_id is part of every key and index)
```

Run it on Postgres:

```bash
npm install pg
export WAKE_DB=postgres://wake@db.internal/wake WAKE_SECRET=$(openssl rand -hex 32)
node bin/wake.js collector --port 8790 --trust-proxy                 # no --config: sites come from the database
node bin/wake.js admin org create --name "Acme" --id acme
node bin/wake.js admin site create --org acme --name "Acme shop" --config acme.config.js   # prints the site id and its first API key
node bin/wake.js admin token --site acme-shop-4f2a1c --url https://collector.example      # a signed dashboard link
```

`node bin/wake.js admin` lists every command: sites, keys (`create`, `import`, `rotate`, `revoke`), configs (`import`, `show`), dashboard links and `copy`.

- **Storage.** `src/storage/sql.js` is the storage interface: one set of SQL for both databases, and `storage.site(id)` is the only way to session data, so every query is scoped by `site_id`. SQLite (`src/storage/sqlite.js`) stays for local and self-hosted use; Postgres (`src/storage/postgres.js`) is for the hosted service. No ORM; `pg` is loaded only for a `postgres://` URL, so the SDK and SQLite users don't need it. Migrations run at startup and are recorded in `schema_migrations` (Postgres takes an advisory lock, so two collectors starting together don't race). Indexes lead with `site_id`: `events (site_id, code, ts)`, `events (site_id, ts)`, `events (site_id, type, ts)`, `sessions (site_id, created_at)`, `sessions (site_id, last_seen)`, `exposures (site_id, ts)`.
- **API keys.** `wk_live_…`, shown once. `key rotate` issues a new key and lets the site's other keys run out after a grace period (24 hours by default), so installs can be redeployed without losing events. `key revoke` stops a key at once on the collector that ran it; other collectors cache key lookups for up to 30 seconds.
- **Config editing.** The dashboard's Config tab edits the mode (Observe = `shadow`, Trace, Route), intents, blocks and rules, including each rule's holdout share. Every save is validated with `normalizeConfig` and stored as a new version; a save based on an older version is refused (`409`) rather than overwriting someone else's edit. Settings the tab doesn't show stay as they were. SDKs get the new version on their next background refresh (about a minute); a collector caches each site's config for 5 seconds.
- **Dashboard access.** With a secret (`--secret` or `WAKE_SECRET`), dashboards open only with a signed link from `wake admin token`: for one site (`--site`) or every site of an organization (`--org`), valid for 30 days (`--days`). The link sets an `HttpOnly`, `SameSite=Strict` cookie scoped to that site's path. A hosted collector has no localhost exception, because behind a reverse proxy every request can look local. Without a secret, the local rule stays: dashboards open on localhost only (or with the site's `dashboard.token`). Links can't be withdrawn one by one; changing the secret signs everyone out.
- **Ingest limits.** Per API key: 60,000 events a minute with bursts of the same size (`createCollector({ limits: { eventsPerMinute } })`). Per request: 1,000 events and 1 MB, checked while reading so a missing `Content-Length` doesn't get around it. Events older than 7 days or more than 5 minutes ahead of the collector's clock (`maxEventAgeMs`, `maxClockSkewMs`) are rejected and counted.

### Moving from a single-site collector

- **Keep running it.** The new collector opens an old single-site SQLite database as it is: on first start its data moves into site `default`, and `--config` becomes version 1 of that site's config. Editing the file later adds a version on the next start, unless the config was edited in the dashboard since; then the dashboard version stays and the collector says so.
- **Move to the hosted collector.** Copy the data into Postgres, register the key the installed SDKs already send, and start without `--config`:

```bash
node bin/wake.js admin copy --from collector.db --to postgres://wake@db.internal/wake
node bin/wake.js admin key import --site default --key wk_demo_123 --db postgres://wake@db.internal/wake
```

### Two sites on one collector (local demo)

```bash
PORT=4000 npm run example:site
export WAKE_DB=hosted.db WAKE_SECRET=local-demo-secret
node bin/wake.js admin org create --name "Demo" --id demo
node bin/wake.js admin site create --org demo --id meridian-east --name "Meridian East" --config examples/meridian/wake.config.js
node bin/wake.js admin site create --org demo --id meridian-west --name "Meridian West" --config examples/meridian/wake.config.js
node bin/wake.js collector --port 8790
node bin/wake.js proxy --config examples/meridian/wake.config.js --endpoint http://127.0.0.1:8790 --api-key <East key> --port 8787 --trust-proxy
node bin/wake.js proxy --config examples/meridian/wake.config.js --endpoint http://127.0.0.1:8790 --api-key <West key> --port 8788 --trust-proxy
node scripts/simulate.js http://127.0.0.1:8787 150
node scripts/simulate.js http://127.0.0.1:8788 60
node bin/wake.js admin token --site meridian-east      # open the printed link
node bin/wake.js admin token --site meridian-west
```

Each link opens only its own site: East shows 150 sessions, West 60. Switch West to Trace in its Config tab, and within a minute the West proxy stops applying rules while East keeps routing.

## Tested

- 46 tests in `test/`: agent detection, codes and URL tokens, link rewriting (HTML, Markdown, absolute and relative links, assets, `<link>` tags), block promotion, intents, URL rescue, statistics, redaction, and full HTTP journeys through a real site server. The journeys cover the agent's first read, search, a rescued 404, a routed and a held-out rule decided from the URL token alone, the agent checking its own link, a person's hand-off and order, crawlers, a forwarded session link, an unreachable site, and dashboard access.
- The SDK setup: Node middleware in an app sending a whole journey over HTTP to a separate collector; the collector down (pages still served, events dropped); config pulled from the collector; wrong API keys refused and secrets kept out of the served config; kill switch; shadow mode returning byte-identical pages while still grouping sessions; trace mode; fail-open on an error; the Worker and Next.js adapters; telemetry batching and buffer limits.
- The hosted collector, on SQLite and (with `WAKE_TEST_PG`) on Postgres: two sites never see each other's sessions, events or configs, even with the same session code; signed site and organization links, forged and expired links refused; key rotation with a grace period and revocation; a config saved in the dashboard reaching an SDK through `createConfigSource` (with a `304` when unchanged), invalid and stale saves refused; per-key rate limits, the payload cap with and without `Content-Length`, and event age. A single-site database from before sites existed opens as site `default`.
- Answer checks with fake assistants and a fake judge: captured questions are asked, wrong claims reach the dashboard with the rule and holdout numbers for their block, failures are recorded, the Claude engine and judge send the right requests (to a fake `fetch`), and `wake check` runs from the command line. No test calls a paid API.
- 400 simulated sessions through the example site, with the proxy and the collector as separate processes. Every report fills in.
- Live, in front of https://www.new-wave.ai. Sessions held across pages, the site's own `/a/NW-…` links nested correctly, the site's absolute `/r/NW-…` sign-up links became hand-off links, and the canonical tag was preserved. Agents guessing `/pricing` get a 404 there today.

## Known gaps

- Agents are recognized by user-agent only. Production use should also verify the vendors' published IP ranges or Web Bot Auth signatures.
- Agentic browsers that use a normal Chrome user-agent (and run JavaScript) look like people and aren't tracked.
- Shadow mode groups reads by hashed IP and user-agent. Big agents share IP pools across many users, so shadow sessions are estimates. Trace and route modes use real session codes.
- The URL token holds intent scores, not the full history. An agent that goes back to an older page continues from that page's state.
- The Next.js adapter fetches the page a second time for agent requests (well under 1% of traffic). It can't see response statuses for people, so report conversions with `wake.conversion()`.
- Hosted collector: rate limits live in each collector's memory, so N collectors behind a load balancer allow N times the limit. On Postgres, ingest makes a few queries per event (no batching yet), and the events table isn't partitioned by time. Dashboard access is by signed link only: there are no user accounts, and no HTTP API for creating sites and keys (use `wake admin`).
- HTML rewriting is regex-based and only handles quoted `href`/`action` on `<a>`, `<area>` and `<form>`. Links built by client-side JavaScript aren't rewritten.
- Answer checks ship with a Claude engine only. ChatGPT, Perplexity and others need an engine adapter (see above). The judge is also an LLM, so read the quotes before you act on a verdict.
- Each answer is judged against every fact, so facts the question never touched show as "not mentioned".
