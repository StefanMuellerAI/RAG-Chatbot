import { beforeEach, describe, expect, it, vi } from "vitest";

// `refresh` darf nur innerhalb einer Server Action laufen — hier gibt es keine.
const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/cache", () => cache);

// lib/api.ts zieht ueber lib/auth/user.ts Clerk herein; der Server-Client
// braucht zur Modulinitialisierung nichts, aber sicher ist sicher.
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: null }),
  currentUser: async () => null,
  clerkClient: async () => ({}),
}));

import {
  normalisiereGroessenklasseEingabe,
  normalisiereModellEingabe,
  normalisiereNutzerAenderung,
  normalisierePlanEingabe,
  pruefeModellKennung,
  pruefePlanKennung,
} from "@/lib/admin";
import { alsAktion } from "@/lib/aktionen";
import { beschreibeFehler } from "@/lib/api";
import { NotAdminError, NotSignedInError } from "@/lib/auth/user";
import { MissingConfigError } from "@/lib/env";
import { NotFoundError, QuotaError, RateLimitError, ValidationError } from "@/lib/errors";

beforeEach(() => {
  cache.refresh.mockClear();
});

describe("beschreibeFehler", () => {
  it("ordnet die bekannten Fehlerarten Status und Code zu", () => {
    expect(beschreibeFehler(new NotSignedInError())).toMatchObject({
      status: 401,
      body: { code: "nicht_angemeldet" },
    });
    expect(beschreibeFehler(new NotAdminError())).toMatchObject({
      status: 403,
      body: { code: "kein_admin" },
    });
    expect(beschreibeFehler(new NotFoundError("Die Sammlung"))).toMatchObject({
      status: 404,
      body: { code: "nicht_gefunden", error: "Die Sammlung wurde nicht gefunden." },
    });
    expect(beschreibeFehler(new ValidationError("Zu kurz."))).toMatchObject({
      status: 400,
      body: { code: "ungueltig", error: "Zu kurz." },
    });
  });

  it("reicht Kontingent, Drosselung und Konfiguration mit Zusatzdaten durch", () => {
    expect(beschreibeFehler(new QuotaError("Voll.", 3, 3))).toMatchObject({
      status: 409,
      body: { code: "kontingent", current: 3, limit: 3 },
    });

    const drossel = beschreibeFehler(new RateLimitError(12));
    expect(drossel.status).toBe(429);
    expect(drossel.headers).toEqual({ "Retry-After": "12" });

    expect(beschreibeFehler(new MissingConfigError(["FALKORDB_URL"]))).toMatchObject({
      status: 503,
      body: { code: "konfiguration", variables: ["FALKORDB_URL"] },
    });
  });

  it("macht aus allem anderen einen 500 mit der Meldung", () => {
    expect(beschreibeFehler(new Error("Kabel raus"))).toMatchObject({
      status: 500,
      body: { code: "unbekannt", error: "Kabel raus" },
    });
    expect(beschreibeFehler("nur ein String")).toMatchObject({
      status: 500,
      body: { error: "Unbekannter Fehler." },
    });
  });
});

describe("alsAktion", () => {
  it("liefert das Ergebnis und rendert die Route neu", async () => {
    const ergebnis = await alsAktion(async () => ({ id: "s1" }));

    expect(ergebnis).toEqual({ ok: true, daten: { id: "s1" } });
    expect(cache.refresh).toHaveBeenCalledTimes(1);
  });

  it("laesst das Neu-Rendern auf Wunsch aus", async () => {
    await alsAktion(async () => undefined, { neuRendern: false });
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it("gibt Fehler als Wert zurueck, mit denselben Meldungen wie die Routen", async () => {
    const fehler = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const abgelehnt = await alsAktion(async () => {
      throw new ValidationError("Die Bezeichnung darf nicht leer sein.");
    });
    expect(abgelehnt).toEqual({
      ok: false,
      fehler: "Die Bezeichnung darf nicht leer sein.",
      code: "ungueltig",
    });
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(fehler).not.toHaveBeenCalled();

    const kaputt = await alsAktion(async () => {
      throw new Error("Datenbank weg");
    });
    expect(kaputt).toMatchObject({ ok: false, code: "unbekannt" });
    expect(fehler).toHaveBeenCalledTimes(1);

    fehler.mockRestore();
  });
});

describe("Eingaben der Admin-Actions", () => {
  it("normalisiert eine Groessenklasse und prueft die Kennung", () => {
    expect(
      normalisiereGroessenklasseEingabe({
        id: "XXL",
        label: " Riesig ",
        rank: "5",
        maxDocuments: "100",
        maxPagesPerDocument: 200,
        maxTotalPages: "20000",
        maxFileMegabytes: 50,
      }),
    ).toEqual({
      id: "XXL",
      label: " Riesig ",
      rank: 5,
      maxDocuments: 100,
      maxPagesPerDocument: 200,
      maxTotalPages: 20000,
      maxFileMegabytes: 50,
    });

    expect(() => normalisiereGroessenklasseEingabe({ id: "zu lang und mit Leerzeichen" })).toThrow(
      ValidationError,
    );
    expect(() => normalisiereGroessenklasseEingabe(null)).toThrow(ValidationError);
    expect(() => normalisiereGroessenklasseEingabe("XL")).toThrow(ValidationError);
  });

  it("normalisiert einen Plan und die Kennung zum Loeschen", () => {
    expect(
      normalisierePlanEingabe({
        id: "team",
        label: "Team",
        maxSizeClassId: "L",
        maxCollections: "10",
        maxQuestionsPerDay: 500,
        modelId: "openai/gpt-5-mini",
        isDefault: "ja",
      }),
    ).toEqual({
      id: "team",
      label: "Team",
      maxSizeClassId: "L",
      maxCollections: 10,
      maxQuestionsPerDay: 500,
      modelId: "openai/gpt-5-mini",
      isDefault: true,
    });

    expect(() => normalisierePlanEingabe({ id: "ein-viel-zu-langer-plan" })).toThrow(ValidationError);
    expect(pruefePlanKennung("  team ")).toBe("team");
    expect(() => pruefePlanKennung("")).toThrow(ValidationError);
    expect(() => pruefePlanKennung(undefined)).toThrow(ValidationError);
  });

  it("normalisiert ein Modell und verlangt einen bekannten Anbieter", () => {
    expect(
      normalisiereModellEingabe({
        id: "google/gemini-2.5-flash",
        provider: "gateway",
        label: "Gemini",
        inputPerMillion: "0.3",
        outputPerMillion: 2.5,
        cacheReadPerMillion: undefined,
        enabled: 1,
      }),
    ).toEqual({
      id: "google/gemini-2.5-flash",
      provider: "gateway",
      label: "Gemini",
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheReadPerMillion: Number.NaN,
      enabled: true,
      sortOrder: 0,
    });

    expect(() => normalisiereModellEingabe({ provider: "mistral" })).toThrow(ValidationError);
    expect(pruefeModellKennung(" openai/gpt-5 ")).toBe("openai/gpt-5");
    expect(() => pruefeModellKennung(null)).toThrow(ValidationError);
  });

  it("nimmt bei Nutzern nur Plan und Rolle in der richtigen Form an", () => {
    expect(
      normalisiereNutzerAenderung({ clerkUserId: "user_1", planId: "team", isAdmin: "true" }),
    ).toEqual({ clerkUserId: "user_1", planId: "team", isAdmin: undefined });
    expect(normalisiereNutzerAenderung({ clerkUserId: "user_1", isAdmin: false })).toEqual({
      clerkUserId: "user_1",
      planId: undefined,
      isAdmin: false,
    });
    expect(() => normalisiereNutzerAenderung({ planId: "team" })).toThrow(ValidationError);
  });
});
