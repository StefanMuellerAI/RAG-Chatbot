import { Ratelimit } from "@upstash/ratelimit";
import { NextResponse } from "next/server";
import { getRedis } from "./redis";

/**
 * Zwei Schutzschichten gegen unbeabsichtigte Kosten und Missbrauch:
 *
 * 1. Rate-Limits (Sliding Window in Redis) — beim Chat pro Nutzer, bei der
 *    Anmeldung pro IP.
 * 2. Ein globales Tagesbudget an Antworten, optional ergaenzt um ein Budget
 *    pro Nutzer — die eigentliche Kostenbremse.
 */

export type LimitName = "chat-minute" | "chat-hour" | "login";

const LIMITS: Record<LimitName, { limiter: () => ReturnType<typeof Ratelimit.slidingWindow>; message: string }> = {
  "chat-minute": {
    limiter: () => Ratelimit.slidingWindow(10, "1 m"),
    message: "Zu viele Anfragen in kurzer Zeit. Bitte einen Moment warten.",
  },
  "chat-hour": {
    limiter: () => Ratelimit.slidingWindow(60, "1 h"),
    message: "Das stuendliche Kontingent ist erreicht. Bitte spaeter erneut versuchen.",
  },
  login: {
    limiter: () => Ratelimit.slidingWindow(5, "1 m"),
    message: "Zu viele Anmeldeversuche. Bitte eine Minute warten.",
  },
};

/** Vercel setzt die Adresse des Aufrufers als ersten Eintrag in x-forwarded-for. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip") || "unbekannt";
}

export type LimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; message: string };

/** Prueft die genannten Limits fuer eine Kennung (IP oder Nutzer-ID); das erste verletzte gewinnt. */
export async function enforceLimits(identifier: string, names: LimitName[]): Promise<LimitResult> {
  const redis = getRedis();

  for (const name of names) {
    const { limiter, message } = LIMITS[name];
    const result = await new Ratelimit({ redis, limiter: limiter(), prefix: `rl:${name}` }).limit(identifier);
    if (!result.success) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
      return { ok: false, retryAfterSeconds, message };
    }
  }
  return { ok: true };
}

export function tooManyRequests(result: Extract<LimitResult, { ok: false }>): NextResponse {
  return NextResponse.json(
    { error: result.message },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
  );
}

// ---------------------------------------------------------------------------
// Tagesbudget
// ---------------------------------------------------------------------------

/** Der Tag wechselt um Mitternacht deutscher Zeit — das erwartet der Kunde. */
const BUDGET_TIMEZONE = "Europe/Berlin";
const BUDGET_TTL_SECONDS = 60 * 60 * 48;

function heute(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: BUDGET_TIMEZONE }).format(new Date());
}

function globalKey(): string {
  return `budget:${heute()}`;
}

function userKey(userId: string): string {
  return `budget:${heute()}:${userId}`;
}

export type BudgetResult =
  | { ok: true }
  | { ok: false; scope: "global" | "user"; used: number; limit: number };

async function reserviere(key: string): Promise<number> {
  const redis = getRedis();
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, BUDGET_TTL_SECONDS);
  return used;
}

/**
 * Reserviert eine Antwort im globalen und — falls ein Nutzerlimit gesetzt
 * ist — im Nutzer-Budget. Ist eines erschoepft, werden die Reservierungen
 * zurueckgenommen, damit die Anzeige die tatsaechlich erzeugten Antworten zeigt.
 */
export async function consumeDailyBudget(options: {
  globalLimit: number;
  userId: string;
  userLimit: number | null;
}): Promise<BudgetResult> {
  const redis = getRedis();

  const globalUsed = await reserviere(globalKey());
  if (globalUsed > options.globalLimit) {
    await redis.decr(globalKey());
    return { ok: false, scope: "global", used: globalUsed - 1, limit: options.globalLimit };
  }

  if (options.userLimit !== null) {
    const userUsed = await reserviere(userKey(options.userId));
    if (userUsed > options.userLimit) {
      await Promise.all([redis.decr(globalKey()), redis.decr(userKey(options.userId))]);
      return { ok: false, scope: "user", used: userUsed - 1, limit: options.userLimit };
    }
  }

  return { ok: true };
}

/** Heute bereits erzeugte Antworten — fuer die Anzeige im Admin. */
export async function dailyUsage(): Promise<number> {
  const value = await getRedis().get<number | string>(globalKey());
  return Number(value ?? 0);
}

export function budgetExhausted(result: Extract<BudgetResult, { ok: false }>): NextResponse {
  const message =
    result.scope === "global"
      ? `Das Tageskontingent von ${result.limit} Antworten ist ausgeschoepft. ` +
        `Morgen steht der Assistent wieder zur Verfuegung.`
      : `Ihr persoenliches Tageskontingent von ${result.limit} Antworten ist ausgeschoepft. ` +
        `Morgen geht es weiter.`;
  return NextResponse.json({ error: message }, { status: 429 });
}
