// Store calls are synchronous with SQLite and return promises with Postgres. Code that talks to a store is
// written once as a generator that yields each store call; flow() runs it. With a synchronous store the whole
// generator finishes before flow() returns (so the in-process proxy and the tests see their writes at once);
// with an asynchronous store flow() returns a promise.

export const isPromise = (v) => v != null && typeof v.then === 'function';

export function flow(gen) {
  function step(method, input) {
    for (;;) {
      const r = gen[method](input);
      if (r.done) return r.value;
      if (isPromise(r.value)) return r.value.then((v) => step('next', v), (err) => step('throw', err));
      method = 'next';
      input = r.value;
    }
  }
  return step('next');
}

/** Wrap a generator function so callers get a value (sync store) or a promise (async store). */
export const flowed = (fn) => (...args) => flow(fn(...args));

/** Run one value-or-promise through a function, keeping it synchronous when it already is. */
export const then = (v, fn) => (isPromise(v) ? v.then(fn) : fn(v));

/**
 * Run fn() for one key at a time. A synchronous result passes straight through; asynchronous work for the
 * same key waits for the previous call (so two batches for one site never race on the same session).
 */
export function createSerial() {
  const tails = new Map();
  return function serial(key, fn) {
    const prev = tails.get(key);
    const result = prev ? prev.then(fn) : fn();
    if (!isPromise(result)) return result;
    const tail = result.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}
