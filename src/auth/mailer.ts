/**
 * Stage 28 Phase 8 — transactional email (auth only: OTP codes, password resets,
 * welcome). Sends via Gmail SMTP (Google Workspace mailbox) using nodemailer.
 *
 * If SMTP isn't configured, falls back to logging the message so auth flows still
 * work in local dev without real delivery.
 */
import nodemailer, { type Transporter } from 'nodemailer';

import {
  EMAIL_FROM,
  EMAIL_SERVER_HOST,
  EMAIL_SERVER_PORT,
  EMAIL_SERVER_USER,
  EMAIL_SERVER_PASSWORD,
} from '../config.js';
import { logger } from '../logger.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (!EMAIL_SERVER_HOST || !EMAIL_SERVER_USER || !EMAIL_SERVER_PASSWORD)
    return null;
  transporter = nodemailer.createTransport({
    host: EMAIL_SERVER_HOST,
    port: EMAIL_SERVER_PORT,
    secure: EMAIL_SERVER_PORT === 465, // 465 = implicit TLS
    auth: { user: EMAIL_SERVER_USER, pass: EMAIL_SERVER_PASSWORD },
  });
  return transporter;
}

export function isEmailConfigured(): boolean {
  return !!getTransporter();
}

/** Send an email. Resolves true on success; logs + resolves false on failure. */
export async function sendMail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) {
    // Dev fallback: surface the content in logs so flows are testable without SMTP.
    logger.warn(
      { to, subject },
      '[mailer] SMTP not configured — email not sent (dev fallback)',
    );
    logger.info({ to, subject, html }, '[mailer] would-send email');
    return false;
  }
  try {
    await tx.sendMail({
      from: EMAIL_FROM || EMAIL_SERVER_USER,
      to,
      subject,
      html,
    });
    logger.info({ to, subject }, '[mailer] email sent');
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, '[mailer] send failed');
    return false;
  }
}

/**
 * Send a plain-text email. Used for agent outreach approved through HITL, not for auth.
 *
 * Plain text is deliberate, not a shortcut. Cold email carrying HTML, a branded wrapper or
 * a tracking pixel lands in spam far more often, and this sends from the founder's own
 * business domain — a reputation that is slow to repair. It should read as a person typing
 * in Gmail, because that is what it is.
 *
 * Returns true on success. Unlike `sendMail`, a missing SMTP config is reported as a
 * failure rather than a dev-fallback log: an outreach email that silently did not send
 * would be recorded as sent, and the send log is the one honest measure of the sales axis.
 */
export async function sendPlainTextMail(
  to: string,
  subject: string,
  text: string,
  thread?: { inReplyTo?: string; references?: string },
): Promise<{ messageId: string }> {
  const tx = getTransporter();
  if (!tx)
    throw new Error(
      'SMTP not configured — set EMAIL_SERVER_HOST/USER/PASSWORD',
    );
  const info = await tx.sendMail({
    from: EMAIL_FROM || EMAIL_SERVER_USER,
    to,
    subject,
    text,
    ...(thread?.inReplyTo ? { inReplyTo: thread.inReplyTo } : {}),
    ...(thread?.references ? { references: thread.references } : {}),
  });
  // The Message-ID is the only durable link between an email we sent and a reply to it:
  // a reply carries it in In-Reply-To / References. Without recording it, matching a reply
  // to a lead falls back to guessing from the sender address.
  const messageId = String(info?.messageId ?? '');
  logger.info({ to, subject, messageId }, '[mailer] plain-text email sent');
  return { messageId };
}

/** Minimal branded wrapper so all auth emails look consistent. */
export function authEmailHtml(heading: string, bodyHtml: string): string {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
    <div style="font-size:18px;font-weight:700;letter-spacing:0.5px;margin-bottom:16px">nanocrew</div>
    <h2 style="font-size:18px;margin:0 0 12px">${heading}</h2>
    <div style="font-size:14px;line-height:1.6;color:#333">${bodyHtml}</div>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
    <div style="font-size:12px;color:#999">If you didn't request this, you can safely ignore this email.</div>
  </div>`;
}

/** Standard OTP-code email. */
export function otpEmailHtml(
  code: string,
  purpose: 'signup' | 'login' | 'reset',
): string {
  const intro =
    purpose === 'signup'
      ? 'Use this code to verify your email and finish creating your account:'
      : purpose === 'login'
        ? 'Use this code to sign in:'
        : 'Use this code to reset your password:';
  return authEmailHtml(
    'Your verification code',
    `
    <p>${intro}</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0;padding:14px;background:#f4f4f5;border-radius:8px;text-align:center">${code}</div>
    <p style="color:#666">This code expires in 10 minutes.</p>
  `,
  );
}
