import { Redis } from "@upstash/redis";
import { MissingConfigError, REDIS_VARIABLES, redisCredentials } from "./env";

/**
 * Upstash Redis traegt drei Dinge: die Admin-Einstellungen (Provider, Modell,
 * verschluesselte API-Keys), die Zaehler fuer Rate-Limit und Tagesbudget sowie
 * den Dokumenten-Index. Alles per REST — funktioniert in Node wie in der
 * Edge-Runtime.
 *
 * Erst im Request-Handler aufrufen, niemals auf Modulebene.
 */
export function getRedis(): Redis {
  const credentials = redisCredentials();
  if (!credentials) throw new MissingConfigError([REDIS_VARIABLES]);
  return new Redis({ url: credentials.url, token: credentials.token });
}
