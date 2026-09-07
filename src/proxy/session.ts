/**
 * Session identity for callers that send none.
 *
 * OpenCode sends `x-opencode-session: ses_<26 chars>` per conversation
 * (packages/schema/src/session-id.ts + identifier.ts); Zen reads it to
 * optimize prompt-cache routing. For clients that carry no session header
 * we mint an id in the exact same format and keep it sticky per caller
 * identity (key / IP / user-agent) with a sliding TTL, so consecutive
 * requests of one conversation share one cache-affinity key instead of
 * fragmenting the prompt cache with a fresh id every turn.
 */

const ID_LENGTH = 26;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

/**
 * Mirror of opencode's descending identifier generator: the low 48 bits of
 * ~(timestamp_ms * 0x1000 + per-ms counter) as 12 hex chars (newest ids sort
 * first), followed by 14 random base62 chars, prefixed with "ses_".
 */
export function generateSessionID(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  let time = "";
  for (let i = 0; i < 6; i++) {
    time += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH - 12));
  let tail = "";
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length];
  return "ses_" + time + tail;
}

export function isValidSessionID(id: string): boolean {
  return /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id);
}

interface PoolEntry {
  id: string;
  expiresAt: number;
}

/**
 * Caller -> session id map with a sliding TTL. Insertion order acts as LRU:
 * every hit re-inserts the entry, so eviction always drops the coldest
 * caller when the cap is reached.
 */
export class SessionIDPool {
  private entries = new Map<string, PoolEntry>();

  constructor(
    private ttlMs: number,
    private maxEntries = 4096,
  ) {}

  /** Stable id for one caller identity; mints a new one only after the TTL lapses. */
  sessionFor(identity: string, now = Date.now()): string {
    if (this.ttlMs <= 0) return generateSessionID(now);
    this.prune(now);
    const existing = this.entries.get(identity);
    if (existing && existing.expiresAt > now) {
      existing.expiresAt = now + this.ttlMs;
      this.entries.delete(identity);
      this.entries.set(identity, existing);
      return existing.id;
    }
    const entry: PoolEntry = { id: generateSessionID(now), expiresAt: now + this.ttlMs };
    this.entries.set(identity, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.id;
  }

  size(): number {
    return this.entries.size;
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
