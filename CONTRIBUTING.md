# Contributing to Wake

Thanks for helping. Run the tests before you open a pull request:

```bash
npm test                       # everything except the Postgres-backed tests
WAKE_TEST_PG=postgres://user@localhost:5432/postgres npm test   # all tests, including Postgres
```

## Licensing of contributions

- Changes outside `ee/` are contributed under the Apache License, Version 2.0, the same license as the code they change.
- Changes inside `ee/` are contributed under the Wake Enterprise License (see `ee/LICENSE`, section 3).
- Code outside `ee/` must never import from `ee/`. `test/license-boundary.test.js` checks this, and checks that every `ee/` source file starts with the enterprise license header.

## Style

- No runtime dependencies in the SDK (`src/sdk`, `adapters/`): it runs inside other people's sites.
- The SDK must fail open. Any error while handling a request returns the site's original response.
- Wake never sits in a customer's request path for anything but the SDK itself. The collector only receives batched events and serves config.
