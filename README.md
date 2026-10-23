# Wake

**See what AI agents do on your website, and what it earns you.**

When someone asks ChatGPT, Claude or Perplexity about your product, the assistant reads your pages for them. Your analytics never see it: agents don't run JavaScript, and the visit that follows usually shows up as "Direct".

Wake follows each of those agent conversations through your site, page by page, and connects it to the person who later clicks the agent's link and buys.

```
Someone asks ChatGPT about family phone plans
  └─ ChatGPT reads /plans/family, searches "mexico", reads /travel/international-pass   ← one Wake session
       └─ 43 minutes later, a person opens the agent's link and orders 4 lines            ← credited to that session
```

## What you get

- **Agent journeys.** Every page an agent read in one conversation, in order, with what it searched for.
- **Why agents visit.** Intents scored from those journeys: comparing prices, switching, cancelling.
- **Revenue that would land as "Direct".** Orders traced back to the agent session that led to them.
- **Pages agents expect.** URLs agents guess that don't exist on your site.
- **What assistants say about you.** Their answers checked against your facts, with the wrong ones listed.
- **A brief per session.** What the agent read and asked, for whoever talks to the customer next.

## How it works

A small SDK runs inside your own stack: your Cloudflare Worker, Next.js middleware or Node server. It recognizes live AI agents, adds a session code to the links on the pages they read, and sends events to the Wake collector after each response.

People and search engines pass straight through. Wake never sits between your visitors and your site, and if anything goes wrong it returns your original page.

## Try it in two minutes

```bash
git clone https://github.com/xhoantran/wake && cd wake && npm install
PORT=4000 npm run example:site      # a sample site
npm start -- --trust-proxy          # Wake in front of it, with a dashboard
npm run simulate                    # 400 simulated agent visits
open http://127.0.0.1:8787/_wake/
```

Needs Node 22.5 or later.

## Add it to your site

**Cloudflare Worker**

```js
import { createWorker } from 'wake/worker';
export default createWorker(); // reads WAKE_API_KEY and WAKE_ENDPOINT from the Worker's settings
```

**Next.js**

```js
import { NextResponse } from 'next/server';
import { wakeNext } from 'wake/next';
const wake = wakeNext({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.example.com' });
export async function middleware(request, event) {
  return (await wake(request, event)) ?? NextResponse.next();
}
```

**Express or any Node server**

```js
import { wakeMiddleware } from 'wake/node-middleware';
app.use(wakeMiddleware({ apiKey: process.env.WAKE_API_KEY, endpoint: 'https://collector.example.com' }));
```

## Start safe

| Mode | What changes on your site | Use it to |
|---|---|---|
| `shadow` | Nothing | See agent traffic with zero risk |
| `trace` (default) | Links on agent-read pages carry a session code | Get exact journeys and revenue |
| `route` | Also reorders page blocks for agents, with a holdout test | Measure what helps agents recommend you |

The session code can travel in the path (`/a/{code}/pricing`) or in a query parameter (`/pricing?wk={code}`). Set `carrier: 'split'` to measure which one survives into more of your customers' clicks.

## Check your install

```bash
npx wake verify https://www.example.com --endpoint https://collector.example.com --api-key "$WAKE_API_KEY"
```

It visits your site as a person, an AI agent and a search crawler. It checks that people are untouched, agent links carry the session, sign-up clicks are credited and events reach the collector. It exits non-zero on a failure, so you can run it in CI after every deploy.

## Open core

The SDK, the single-site collector and its dashboard are [Apache-2.0](LICENSE). Hosting many sites (organizations, API keys, Postgres, the Cloudflare collector) is **Wake Enterprise** in [`ee/`](ee/LICENSE): free to read and try, and production use needs a subscription.

## Learn more

- [Reference](docs/reference.md): configuration, the collector API, deploying to Cloudflare, tests and known limits
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
