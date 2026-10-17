/**
 * Notification sinks — pluggable output channels for policy escalations.
 *
 * The policy engine and recovery engine route alerts through a NotificationSink
 * so the delivery mechanism (dashboard push, webhook, WhatsApp) is swappable
 * without touching the policy logic.
 *
 * Built-in sinks:
 *   LogSink     — writes to the process logger (always present as fallback).
 *   SocketSink  — pushes to Socket.IO dashboard clients.
 *   WebhookSink — HTTP POST to a configured URL (Discord, Slack, n8n, etc.).
 *   FanoutSink  — broadcasts to multiple sinks simultaneously.
 */

import { logger } from '../logger.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface NotificationSink {
  /** Send a notification. channel is a hint (e.g. "dashboard", "webhook"). */
  notify(
    channel: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void>;
}

// ─── LogSink ──────────────────────────────────────────────────────────────────

/** Fallback sink — writes every notification to the process logger. */
export class LogSink implements NotificationSink {
  async notify(
    channel: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    logger.info({ channel, ...(meta ?? {}) }, `[notification] ${text}`);
  }
}

// ─── SocketSink ───────────────────────────────────────────────────────────────

import type { Server as SocketIOServer } from 'socket.io';

/** Push notifications to connected dashboard clients via Socket.IO. */
export class SocketSink implements NotificationSink {
  constructor(private getIo: () => SocketIOServer | null) {}

  async notify(
    channel: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const io = this.getIo();
    if (!io) return;
    io.emit('policy_notification', {
      channel,
      text,
      ts: new Date().toISOString(),
      ...(meta ?? {}),
    });
    logger.info({ channel }, `[socket notification] ${text}`);
  }
}

// ─── WebhookSink ──────────────────────────────────────────────────────────────

export interface WebhookSinkOptions {
  /** Full URL to POST to. */
  url: string;
  /** Optional secret sent in X-Webhook-Secret header. */
  secret?: string;
  /** Timeout in ms. Default: 5000. */
  timeoutMs?: number;
}

/**
 * Post notifications to an HTTP endpoint.
 * Body: `{ channel, text, ts, ...meta }`
 *
 * Compatible with Discord (via discord.com/api/webhooks/*), Slack incoming
 * webhooks, n8n webhook triggers, and generic REST endpoints.
 */
export class WebhookSink implements NotificationSink {
  private url: string;
  private secret?: string;
  private timeoutMs: number;

  constructor(opts: WebhookSinkOptions) {
    this.url = opts.url;
    this.secret = opts.secret;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async notify(
    channel: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      channel,
      text,
      ts: new Date().toISOString(),
      ...(meta ?? {}),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.secret) headers['X-Webhook-Secret'] = this.secret;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn(
          { status: res.status, url: this.url },
          'WebhookSink: non-OK response',
        );
      }
    } catch (err) {
      logger.warn({ err, url: this.url }, 'WebhookSink: delivery failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── FanoutSink ───────────────────────────────────────────────────────────────

/** Broadcast to multiple sinks in parallel. All errors are caught and logged. */
export class FanoutSink implements NotificationSink {
  constructor(private sinks: NotificationSink[]) {}

  async notify(
    channel: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await Promise.allSettled(
      this.sinks.map((s) =>
        s
          .notify(channel, text, meta)
          .catch((err) => logger.warn({ err }, 'FanoutSink: sink error')),
      ),
    );
  }

  add(sink: NotificationSink): void {
    this.sinks.push(sink);
  }
}

// ─── Builder helper ───────────────────────────────────────────────────────────

/**
 * Build a FanoutSink from environment / config.
 * Always includes LogSink; adds WebhookSink when nanocrew_WEBHOOK_URL is set.
 */
export function buildNotificationSink(
  getIo: () => SocketIOServer | null,
): FanoutSink {
  const sinks: NotificationSink[] = [new LogSink(), new SocketSink(getIo)];

  const webhookUrl = process.env.nanocrew_WEBHOOK_URL;
  if (webhookUrl) {
    sinks.push(
      new WebhookSink({
        url: webhookUrl,
        secret: process.env.nanocrew_WEBHOOK_SECRET,
      }),
    );
    logger.info({ url: webhookUrl }, 'NotificationSink: WebhookSink enabled');
  }

  return new FanoutSink(sinks);
}
