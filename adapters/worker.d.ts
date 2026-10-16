// Types for wake/worker (Cloudflare Workers).
export interface WakeTelemetry {
  emit(event: unknown): void;
  flush(): Promise<void>;
}

export interface WakeWorkerOptions {
  /** Defaults to env.WAKE_API_KEY. */
  apiKey?: string;
  /** The collector, e.g. https://collector.example.com. Defaults to env.WAKE_ENDPOINT. */
  endpoint?: string;
  /** A local config. Without one, the SDK pulls its config from the collector. */
  config?: Record<string, unknown>;
  /** A custom event sink, mainly for tests. */
  telemetry?: WakeTelemetry;
  /** The fetch used to reach the collector. */
  fetch?: typeof fetch;
}

export interface WakeEnv {
  WAKE_API_KEY?: string;
  WAKE_ENDPOINT?: string;
  /** "1" turns Wake off: every request goes straight to your Worker. */
  WAKE_DISABLED?: string;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerHandler<Env, Ctx> {
  fetch(request: Request, env: Env, ctx: Ctx): Response | Promise<Response>;
}

/** Wrap an existing Worker with Wake. Returns a handler of the same shape. */
export function withWake<Env extends WakeEnv, Ctx extends WaitUntilContext, App extends WorkerHandler<Env, Ctx>>(app: App, options?: WakeWorkerOptions): App;

/** A Worker that sits in front of your origin: next() is fetch() to the same zone. */
export function createWorker(options?: WakeWorkerOptions): {
  fetch(request: Request, env?: WakeEnv, ctx?: Partial<WaitUntilContext>): Promise<Response>;
};
