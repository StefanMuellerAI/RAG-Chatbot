/**
 * Ein Redis im Speicher mit genau den Befehlen, die die Bibliotheken nutzen.
 * Werte werden als Strings gehalten und unveraendert zurueckgegeben — so
 * laeuft in den Tests der "String"-Zweig der JSON-Parser.
 */

type Hash = Map<string, string>;

export const keys = new Map<string, string>();
export const hashes = new Map<string, Hash>();

export function reset(): void {
  keys.clear();
  hashes.clear();
}

function hash(key: string): Hash {
  let h = hashes.get(key);
  if (!h) {
    h = new Map();
    hashes.set(key, h);
  }
  return h;
}

export const fakeRedis = {
  async get(key: string) {
    return keys.get(key) ?? null;
  },
  async set(key: string, value: string) {
    keys.set(key, String(value));
    return "OK";
  },
  async del(...list: string[]) {
    let n = 0;
    for (const key of list) {
      if (keys.delete(key)) n++;
      if (hashes.delete(key)) n++;
    }
    return n;
  },
  async incr(key: string) {
    const next = Number(keys.get(key) ?? 0) + 1;
    keys.set(key, String(next));
    return next;
  },
  async decr(key: string) {
    const next = Number(keys.get(key) ?? 0) - 1;
    keys.set(key, String(next));
    return next;
  },
  async expire() {
    return 1;
  },
  async hset(key: string, fields: Record<string, unknown>) {
    const h = hash(key);
    for (const [field, value] of Object.entries(fields)) h.set(field, String(value));
    return Object.keys(fields).length;
  },
  async hget(key: string, field: string) {
    return hashes.get(key)?.get(field) ?? null;
  },
  async hgetall(key: string) {
    const h = hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries(h);
  },
  async hdel(key: string, ...fields: string[]) {
    const h = hashes.get(key);
    if (!h) return 0;
    let n = 0;
    for (const field of fields) if (h.delete(field)) n++;
    return n;
  },
  async hexists(key: string, field: string) {
    return hashes.get(key)?.has(field) ? 1 : 0;
  },
};
