/**
 * SecretsManager — generic user-managed secrets with global + per-agent scope.
 *
 * Store file: data/secrets.enc (separate from credentials.enc)
 * Key namespace: "global:<NAME>" | "agent:<agentId>:<NAME>"
 *
 * Encryption: AES-256-GCM keyed from nanocrew_SECRET_KEY.
 * Values are NEVER returned over HTTP — only names + masked last-4.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { encrypt, decrypt, decryptWithMigration } from './secret-crypto.js';

const SECRETS_FILE = path.join(DATA_DIR, 'secrets.enc');
const VALID_NAME = /^[A-Z][A-Z0-9_]*$/;

interface SecretEntry {
  encryptedValue: string;
  createdAt: string;
}

type SecretsStore = Record<string, SecretEntry>;

function loadStore(): SecretsStore {
  if (!fs.existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStore(store: SecretsStore): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * `global` is platform-wide — every tenant's agents receive it, which is why writing it is
 * admin-only. `owner` is a customer's own connections; `agent` overrides for one agent.
 *
 * The owner scope closes the gap described in docs/research/stage37/credentials-architecture.md:
 * before it, a customer-specific value had nowhere correct to live. The credential store is
 * platform-wide and admin-only, so a customer connecting their own X account or Apollo key
 * could only put it on a single agent — re-entering it for every agent that needed it, or
 * (worse) having an operator put it in `global`, where it leaks to every other tenant.
 */
type Scope = 'global' | { ownerId: string } | { agentId: string };

/**
 * The store-key prefix for a scope. Single source of truth for the key layout — `list`
 * previously built its own prefix and handled only two of the three scopes, so an owner
 * scope fell through a cast to `{ agentId }` and produced `agent:undefined:`. Owner
 * secrets could be written and resolved but never enumerated, which reads as an empty
 * page rather than an error. Deriving both key and prefix from here removes that class.
 */
function scopePrefix(scope: Scope): string {
  if (scope === 'global') return 'global:';
  if ('ownerId' in scope) return `owner:${scope.ownerId}:`;
  return `agent:${scope.agentId}:`;
}

function storeKey(scope: Scope, name: string): string {
  return scopePrefix(scope) + name;
}

export interface SecretSummary {
  name: string;
  masked: string;
  createdAt: string;
}

export class SecretsManager {
  set(scope: Scope, name: string, value: string): void {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid secret name '${name}' — must match [A-Z][A-Z0-9_]* (uppercase env-var style).`,
      );
    }
    const store = loadStore();
    store[storeKey(scope, name)] = {
      encryptedValue: encrypt(value),
      createdAt: new Date().toISOString(),
    };
    saveStore(store);
  }

  delete(scope: Scope, name: string): void {
    const store = loadStore();
    delete store[storeKey(scope, name)];
    saveStore(store);
  }

  list(scope: Scope): SecretSummary[] {
    const store = loadStore();
    const prefix = scopePrefix(scope);

    return Object.entries(store)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, entry]) => {
        const name = k.slice(prefix.length);
        let masked = '••••';
        try {
          const val = decrypt(entry.encryptedValue);
          masked = val.length > 4 ? '••••' + val.slice(-4) : '••••';
        } catch {
          /* keep default */
        }
        return { name, masked, createdAt: entry.createdAt };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Returns merged NAME→plaintext for injection into the sidecar / cycle env.
   *
   * Resolution is most-specific-wins: platform (`global`) → owner → agent. An agent
   * override beats the customer's account-wide value, which beats the platform default —
   * so a customer can connect one X account for everything and still point a single agent
   * at a different one, without either clobbering the other.
   *
   * `ownerId` is optional so existing callers keep working; passing it is what activates
   * the owner tier. Values are NEVER exposed over HTTP — internal injection only.
   */
  getAll(agentId: string, ownerId?: string | null): Record<string, string> {
    const store = loadStore();
    const result: Record<string, string> = {};
    let migrated = false;

    const collect = (prefix: string) => {
      for (const [k, entry] of Object.entries(store)) {
        if (!k.startsWith(prefix)) continue;
        const name = k.slice(prefix.length);
        try {
          const { plaintext, staleKey } = decryptWithMigration(
            entry.encryptedValue,
          );
          result[name] = plaintext;
          // Convert in place the first time a legacy-encrypted value is read, so
          // setting nanocrew_SECRET_KEY needs no migration step and leaves no
          // window where a credential is unreadable.
          if (staleKey) {
            entry.encryptedValue = encrypt(plaintext);
            migrated = true;
          }
        } catch {
          /* corrupted or key genuinely lost — skip rather than crash */
        }
      }
    };

    collect('global:');
    if (ownerId) collect(`owner:${ownerId}:`);
    collect(`agent:${agentId}:`);

    if (migrated) {
      try {
        saveStore(store);
        logger.info('Re-encrypted secrets under the current key');
      } catch {
        /* non-fatal — values were still returned correctly */
      }
    }
    return result;
  }
}

export const secretsManager = new SecretsManager();
