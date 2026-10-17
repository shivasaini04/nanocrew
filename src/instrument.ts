/**
 * Stage 28 Topic 10 — error tracking (Sentry). Imported FIRST in index.ts so it
 * initializes before anything else (required by @sentry/node v10 for auto-capture
 * of uncaught exceptions + unhandled rejections).
 *
 * No-op unless SENTRY_DSN is set, so dev/self-host runs without it. The @sentry/node
 * package is loaded lazily and defensively: if it isn't installed (e.g. a build that
 * predates the dependency) or fails to init, we log and continue rather than crash the
 * whole orchestrator. Error tracking only — no performance tracing (tracesSampleRate: 0).
 */
import { createRequire } from 'node:module';

let Sentry: typeof import('@sentry/node') | undefined;

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  try {
    const require = createRequire(import.meta.url);
    Sentry = require('@sentry/node');
    Sentry!.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,
    });
  } catch (err) {
    Sentry = undefined;
    console.warn(
      '[sentry] error tracking disabled — @sentry/node unavailable or failed to init:',
      err instanceof Error ? err.message : err,
    );
  }
}

export { Sentry };
