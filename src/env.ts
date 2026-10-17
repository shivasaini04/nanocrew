import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

export const MANAGED_KEYS = [
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_KIMI_API_KEY',
  'REPLICATE_API_KEY',
  'DASHBOARD_PORT',
  // Platform-wide policy (non-secret)
  'GLOBAL_DAILY_BUDGET_USD', // empty = no cap. Number = USD cap across all agents per day.
  'MODEL_PRIORITY', // comma-separated fallback chain, e.g. "deepseek/deepseek-chat,gemini/gemini-2.0-flash"
  'LIGHT_MODEL', // cheap/fast model for conversational replies, e.g. "groq/llama-3.3-70b-versatile"
];

/**
 * Safely updates or appends keys to the .env file.
 * Preserves comments and existing formatting.
 */
export function writeEnvFile(updates: Record<string, string>): void {
  const envFile = path.join(process.cwd(), '.env');
  let lines: string[] = [];

  if (fs.existsSync(envFile)) {
    lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  }

  const updatedKeys = new Set<string>();

  // Update existing keys
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      if (updates[key] !== undefined) {
        lines[i] = `${key}=${updates[key]}`;
        updatedKeys.add(key);
      }
    }
  }

  // Append new keys
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envFile, lines.join('\n'));

  // Reflect the change in the running process so settings like
  // GLOBAL_DAILY_BUDGET_USD take effect immediately, without a restart.
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}
