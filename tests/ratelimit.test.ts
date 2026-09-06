import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GLOBAL_KONTINGENT_SCRIPT,
  NUTZER_KONTINGENT_SCRIPT,
  ausZwischenspeicher,
  fensterSchluessel,
  tagesSchluessel,
  verwirfProzessZwischenspeicher,
  verwirfZwischenspeicher,
} from "@/lib/ratelimit";

describe("Zwischenspeicher im Prozess", () => {
  afterEach(() => { verwirfProzessZwischenspeicher(); vi.useRealTimers(); });

  it("liefert einen frisch geladenen Wert 15 Sekunden lang ohne erneutes Laden", async () => {
    vi.useFakeTimers();
    const laden = vi.fn(async () => ({ plan: "S" }));
    expect(await ausZwischenspeicher("test:kontext", 60, laden)).toEqual({ plan: "S" });
    expect(await ausZwischenspeicher("test:kontext", 60, laden)).toEqual({ plan: "S" });
    expect(laden).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15_001);
    await ausZwischenspeicher("test:kontext", 60, laden);
    expect(laden).toHaveBeenCalledTimes(2);
  });

  it("haelt sich an eine kuerzere Lebensdauer des Aufrufers", async () => {
    vi.useFakeTimers();
    const laden = vi.fn(async () => 1);
    await ausZwischenspeicher("test:kurz", 5, laden);
    vi.advanceTimersByTime(5_001);
    await ausZwischenspeicher("test:kurz", 5, laden);
    expect(laden).toHaveBeenCalledTimes(2);
  });

  it("vergisst einen Wert sofort, wenn er verworfen wird", async () => {
    const laden = vi.fn(async () => "alt");
    await ausZwischenspeicher("test:verwerfen", 60, laden);
    await verwirfZwischenspeicher("test:verwerfen");
    laden.mockResolvedValue("neu");
    expect(await ausZwischenspeicher("test:verwerfen", 60, laden)).toBe("neu");
  });
});

describe("Kontingent-Schluessel", () => {
  it("leitet aktuelles und vorheriges Fenster aus dem Zeitpunkt ab", () => {
    const [aktuell, vorher] = fensterSchluessel("wa:kurz:{u1}", 60_000 * 1000 + 5);
    expect(aktuell).toBe("wa:kurz:{u1}:1000");
    expect(vorher).toBe("wa:kurz:{u1}:999");
  });
  it("haelt Tageszaehler und Kurzfenster eines Nutzers im selben Hash-Slot", () => {
    expect(tagesSchluessel("user_1", "2026-09-06")).toBe("wa:tag:{user_1}:2026-09-06");
    expect(fensterSchluessel("wa:kurz:{user_1}", 0)[0]).toContain("{user_1}");
  });
});

// Nur ein eigens gestarteter, wegwerfbarer Redis. Niemals Produktionszugaenge.
const socket = process.env.REDIS_TEST_SOCKET;
const cli = promisify(execFile);
async function redis(...args: string[]): Promise<string> {
  const { stdout } = await cli(process.env.REDIS_CLI ?? "redis-cli", ["-s", socket!, "--raw", ...args]);
  if (/^(ERR|error)/i.test(stdout)) throw new Error(stdout);
  return stdout.trim();
}
const zeilen = (ausgabe: string) => ausgabe.split("\n").map(Number);

describe.skipIf(!socket)("Kontingent-Skripte gegen wegwerfbaren Redis", () => {
  const fenster = "60000";
  const nutzer = (p: string, jetzt: number, kurz = "10", tag = "200") =>
    redis("EVAL", NUTZER_KONTINGENT_SCRIPT, "3", `${p}:k:${Math.floor(jetzt / 60000)}`, `${p}:k:${Math.floor(jetzt / 60000) - 1}`, `${p}:tag`, kurz, fenster, String(jetzt), tag, "129600");

  it("laesst zehn Fragen im Fenster zu und weist die elfte mit Reset-Zeitpunkt ab", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const jetzt = 60000 * 100 + 30000;
    for (let i = 1; i <= 10; i++) expect(zeilen(await nutzer(p, jetzt))).toEqual([1, i]);
    expect(zeilen(await nutzer(p, jetzt))).toEqual([0, 60000 * 101]);
    // Abgewiesen heisst nicht gezaehlt: der Tageszaehler bleibt bei zehn.
    expect(await redis("GET", `${p}:tag`)).toBe("10");
  });

  it("gewichtet das vorherige Fenster anteilig", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const fensterStart = 60000 * 200;
    await redis("SET", `${p}:k:199`, "10");
    // Zu Beginn des Fensters zaehlt das alte voll: keine Frage frei.
    expect(zeilen(await nutzer(p, fensterStart))[0]).toBe(0);
    // Nach 30 Sekunden zaehlt es zur Haelfte: fuenf Fragen frei.
    for (let i = 0; i < 5; i++) expect(zeilen(await nutzer(p, fensterStart + 30000))[0]).toBe(1);
    expect(zeilen(await nutzer(p, fensterStart + 30000))[0]).toBe(0);
  });

  it("weist bei erschoepftem Tageskontingent ab, ohne das Kurzfenster zu belasten", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const jetzt = 60000 * 300;
    await redis("SET", `${p}:tag`, "200");
    expect(zeilen(await nutzer(p, jetzt))).toEqual([-1, 200]);
    expect(await redis("EXISTS", `${p}:k:300`)).toBe("0");
  });

  it("setzt die Lebensdauer des Tageszaehlers nur beim ersten Stand", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const jetzt = 60000 * 400;
    await nutzer(p, jetzt);
    const ttl = Number(await redis("TTL", `${p}:tag`));
    expect(ttl).toBeGreaterThan(129000);
    await redis("EXPIRE", `${p}:tag`, "100");
    await nutzer(p, jetzt);
    expect(Number(await redis("TTL", `${p}:tag`))).toBeLessThanOrEqual(100);
  });

  it("bremst global ueber alle Nutzer", async () => {
    const p = `test:${crypto.randomUUID()}`;
    const jetzt = 60000 * 500 + 1000;
    const global = () => redis("EVAL", GLOBAL_KONTINGENT_SCRIPT, "2", `${p}:g:500`, `${p}:g:499`, "3", fenster, String(jetzt));
    for (let i = 0; i < 3; i++) expect(zeilen(await global())).toEqual([1, 0]);
    expect(zeilen(await global())).toEqual([0, 60000 * 501]);
  });
});
