import { beforeEach, describe, expect, it, vi } from "vitest";

// Clerk als Attrappe im Speicher: geprueft wird, was DIESE Schicht tut —
// Eingaben pruefen, den Plan mitgeben, Fehler uebersetzen —, nicht Clerk.
type Attrappe = {
  id: string;
  emailAddress: string;
  publicMetadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  status: "pending" | "accepted" | "revoked";
  url?: string;
  raw?: { id: string; expires_at?: number | null } | null;
};

const einladungen: Attrappe[] = [];
const aufrufe: { create: unknown[]; list: unknown[]; revoke: string[] } = {
  create: [],
  list: [],
  revoke: [],
};
let naechsterFehler: unknown = null;

const TAG = 24 * 60 * 60 * 1000;
const JETZT = Date.parse("2026-09-02T08:00:00Z");

function clerkFehler(status: number, code: string, longMessage?: string) {
  const fehler = new Error(longMessage ?? code) as Error & {
    clerkError: true;
    status: number;
    errors: { code: string; message: string; longMessage?: string }[];
  };
  fehler.clerkError = true;
  fehler.status = status;
  fehler.errors = [{ code, message: code, longMessage }];
  return fehler;
}

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    invitations: {
      createInvitation: async (params: {
        emailAddress: string;
        publicMetadata?: Record<string, unknown>;
        expiresInDays?: number;
      }) => {
        aufrufe.create.push(params);
        if (naechsterFehler) {
          const fehler = naechsterFehler;
          naechsterFehler = null;
          throw fehler;
        }
        const neu: Attrappe = {
          id: `inv_${einladungen.length + 1}`,
          emailAddress: params.emailAddress,
          publicMetadata: params.publicMetadata ?? null,
          createdAt: JETZT,
          updatedAt: JETZT,
          status: "pending",
          url: `https://accounts.example.dev/sign-up?__clerk_ticket=t${einladungen.length + 1}`,
          raw: { id: "x", expires_at: JETZT + (params.expiresInDays ?? 30) * TAG },
        };
        einladungen.push(neu);
        return neu;
      },
      getInvitationList: async (params: unknown) => {
        aufrufe.list.push(params);
        const offen = einladungen.filter((e) => e.status === "pending");
        return { data: offen, totalCount: offen.length };
      },
      revokeInvitation: async (id: string) => {
        aufrufe.revoke.push(id);
        if (naechsterFehler) {
          const fehler = naechsterFehler;
          naechsterFehler = null;
          throw fehler;
        }
        const treffer = einladungen.find((e) => e.id === id);
        if (!treffer) throw clerkFehler(404, "resource_not_found", "Not found");
        treffer.status = "revoked";
        return treffer;
      },
    },
  }),
}));

// Die Tabelle plans als feste Liste: S ist Standard, M gibt es auch, XXL nicht.
const PLAENE = [
  { id: "S", isDefault: true },
  { id: "M", isDefault: false },
];

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({ from: async () => PLAENE }),
    query: {
      plans: {
        // Der Filter ist ein Drizzle-Ausdruck; hier reicht die Kennung daraus.
        findFirst: async ({ where }: { where: unknown }) => {
          const gesucht = kennungAus(where);
          const plan = PLAENE.find((p) => p.id === gesucht);
          return plan ? { id: plan.id } : undefined;
        },
      },
    },
  }),
}));

/** Zieht den Vergleichswert aus `eq(plans.id, wert)`. */
function kennungAus(where: unknown): string | undefined {
  const teile = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
  for (const teil of teile) {
    if (teil && typeof teil === "object" && "value" in teil) {
      const wert = (teil as { value: unknown }).value;
      if (typeof wert === "string") return wert;
    }
  }
  return undefined;
}

import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  EINLADUNG_GUELTIG_TAGE,
  erstelleEinladung,
  ladeEinladungen,
  planAusEinladung,
  pruefeEmail,
  uebersetzeClerkFehler,
  widerrufeEinladung,
  zuEinladung,
} from "@/lib/einladungen";

const APP = "https://wissen.example.de";

beforeEach(() => {
  einladungen.length = 0;
  aufrufe.create.length = 0;
  aufrufe.list.length = 0;
  aufrufe.revoke.length = 0;
  naechsterFehler = null;
});

describe("pruefeEmail", () => {
  it("trimmt, schreibt klein und weist Unbrauchbares ab", () => {
    expect(pruefeEmail("  Anna.Muster@Example.DE ")).toBe("anna.muster@example.de");
    expect(() => pruefeEmail("")).toThrow(ValidationError);
    expect(() => pruefeEmail("   ")).toThrow(ValidationError);
    expect(() => pruefeEmail("anna@")).toThrow(ValidationError);
    expect(() => pruefeEmail("anna example.de")).toThrow(ValidationError);
    expect(() => pruefeEmail("anna@example")).toThrow(ValidationError);
    expect(() => pruefeEmail(42)).toThrow(ValidationError);
    expect(() => pruefeEmail(`${"a".repeat(250)}@example.de`)).toThrow(ValidationError);
  });
});

describe("erstelleEinladung", () => {
  it("gibt Clerk die normalisierte Adresse, den Plan und den Sign-up-Link mit", async () => {
    const einladung = await erstelleEinladung({
      email: " Anna@Example.de ",
      planId: "M",
      appUrl: `${APP}/admin?seite=2`,
    });

    expect(aufrufe.create).toEqual([
      {
        emailAddress: "anna@example.de",
        redirectUrl: `${APP}/sign-up`,
        expiresInDays: EINLADUNG_GUELTIG_TAGE,
        publicMetadata: { planId: "M" },
        notify: true,
      },
    ]);
    expect(einladung).toMatchObject({
      id: "inv_1",
      email: "anna@example.de",
      planId: "M",
      createdAt: "2026-09-02T08:00:00.000Z",
      expiresAt: "2026-09-16T08:00:00.000Z",
    });
    expect(einladung.url).toContain("__clerk_ticket");
  });

  it("nimmt ohne Plan den Standardplan", async () => {
    await erstelleEinladung({ email: "b@example.de", planId: "", appUrl: APP });
    await erstelleEinladung({ email: "c@example.de", appUrl: APP });

    expect((aufrufe.create[0] as { publicMetadata: unknown }).publicMetadata).toEqual({ planId: "S" });
    expect((aufrufe.create[1] as { publicMetadata: unknown }).publicMetadata).toEqual({ planId: "S" });
  });

  it("weist einen unbekannten Plan ab, bevor Clerk gefragt wird", async () => {
    await expect(
      erstelleEinladung({ email: "d@example.de", planId: "XXL", appUrl: APP }),
    ).rejects.toThrow(/Plan "XXL" existiert nicht/);
    expect(aufrufe.create).toHaveLength(0);
  });

  it("weist eine ungueltige Adresse ab, bevor Clerk gefragt wird", async () => {
    await expect(erstelleEinladung({ email: "kein-mail", appUrl: APP })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(aufrufe.create).toHaveLength(0);
  });

  it("verlangt eine brauchbare Adresse der Anwendung", async () => {
    await expect(
      erstelleEinladung({ email: "e@example.de", appUrl: "nicht-eine-url" }),
    ).rejects.toThrow(/Adresse der Anwendung/);
    await expect(
      erstelleEinladung({ email: "e@example.de", appUrl: "ftp://wissen.example.de" }),
    ).rejects.toThrow(/Adresse der Anwendung/);
    expect(aufrufe.create).toHaveLength(0);
  });

  it("uebersetzt eine doppelte Einladung in eine deutsche Meldung", async () => {
    naechsterFehler = clerkFehler(400, "duplicate_record", "An invitation already exists");

    const fehler = await erstelleEinladung({ email: "anna@example.de", appUrl: APP }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(fehler).toBeInstanceOf(ValidationError);
    expect((fehler as Error).message).toMatch(/"anna@example.de".*offene Einladung.*widerrufen/);
  });

  it("nennt beim vorhandenen Konto die Nutzerliste als Weg", async () => {
    naechsterFehler = clerkFehler(422, "form_identifier_exists", "That email address is taken.");

    await expect(erstelleEinladung({ email: "anna@example.de", appUrl: APP })).rejects.toThrow(
      /bereits ein Konto.*Nutzerliste/,
    );
  });
});

describe("uebersetzeClerkFehler", () => {
  it("bildet die bekannten Codes auf eigene Fehlerklassen ab", () => {
    expect(uebersetzeClerkFehler(clerkFehler(400, "duplicate_record"), "x@example.de"))
      .toBeInstanceOf(ValidationError);
    expect(uebersetzeClerkFehler(clerkFehler(400, "duplicate_record"), "x@example.de").message)
      .toMatch(/"x@example.de".*offene Einladung/);
    expect(uebersetzeClerkFehler(clerkFehler(422, "form_identifier_exists")))
      .toBeInstanceOf(ValidationError);
    expect(uebersetzeClerkFehler(clerkFehler(422, "form_param_format_invalid")).message)
      .toMatch(/E-Mail-Adresse/);
    expect(uebersetzeClerkFehler(clerkFehler(404, "resource_not_found")))
      .toBeInstanceOf(NotFoundError);
  });

  it("gibt sonstige 4xx mit Clerks Text weiter, laesst 5xx und Fremdes unveraendert", () => {
    const abgelehnt = uebersetzeClerkFehler(
      clerkFehler(400, "form_param_unknown", "redirect_url is not allowed"),
    );
    expect(abgelehnt).toBeInstanceOf(ValidationError);
    expect(abgelehnt.message).toContain("redirect_url is not allowed");

    const serverfehler = clerkFehler(500, "internal_clerk_error");
    expect(uebersetzeClerkFehler(serverfehler)).toBe(serverfehler);

    const fremd = new TypeError("fetch failed");
    expect(uebersetzeClerkFehler(fremd)).toBe(fremd);
    expect(uebersetzeClerkFehler("kein Fehlerobjekt")).toBeInstanceOf(Error);
    expect(uebersetzeClerkFehler("kein Fehlerobjekt")).not.toBeInstanceOf(ValidationError);
  });
});

describe("ladeEinladungen", () => {
  it("fragt nur offene, neueste zuerst, und bildet die Felder ab", async () => {
    await erstelleEinladung({ email: "a@example.de", planId: "M", appUrl: APP });
    await erstelleEinladung({ email: "b@example.de", appUrl: APP });
    await widerrufeEinladung("inv_1");

    const liste = await ladeEinladungen();

    expect(aufrufe.list).toEqual([{ status: "pending", orderBy: "-created_at", limit: 100 }]);
    expect(liste).toEqual([
      {
        id: "inv_2",
        email: "b@example.de",
        planId: "S",
        createdAt: "2026-09-02T08:00:00.000Z",
        expiresAt: "2026-09-16T08:00:00.000Z",
        url: "https://accounts.example.dev/sign-up?__clerk_ticket=t2",
      },
    ]);
  });
});

describe("zuEinladung", () => {
  it("rechnet den Ablauf aus dem Erstelldatum, wenn Clerk kein expires_at liefert", () => {
    const abbild = zuEinladung({
      id: "inv_9",
      emailAddress: "z@example.de",
      publicMetadata: null,
      createdAt: JETZT,
      raw: null,
    });
    expect(abbild.expiresAt).toBe(new Date(JETZT + EINLADUNG_GUELTIG_TAGE * TAG).toISOString());
    expect(abbild.url).toBeNull();
    expect(abbild.planId).toBeNull();
  });

  it("uebernimmt planId nur, wenn sie eine nicht-leere Zeichenkette ist", () => {
    const basis = { id: "i", emailAddress: "z@example.de", createdAt: JETZT };
    expect(zuEinladung({ ...basis, publicMetadata: { planId: "M" } }).planId).toBe("M");
    expect(zuEinladung({ ...basis, publicMetadata: { planId: "" } }).planId).toBeNull();
    expect(zuEinladung({ ...basis, publicMetadata: { planId: 7 } }).planId).toBeNull();
    expect(zuEinladung({ ...basis, publicMetadata: { anderes: true } }).planId).toBeNull();
  });
});

describe("widerrufeEinladung", () => {
  it("reicht die Kennung an Clerk durch", async () => {
    await erstelleEinladung({ email: "a@example.de", appUrl: APP });
    await widerrufeEinladung(" inv_1 ");
    expect(aufrufe.revoke).toEqual(["inv_1"]);
    expect(await ladeEinladungen()).toEqual([]);
  });

  it("meldet Unbekanntes als nicht gefunden und Leeres als Eingabefehler", async () => {
    await expect(widerrufeEinladung("inv_fehlt")).rejects.toBeInstanceOf(NotFoundError);
    await expect(widerrufeEinladung("")).rejects.toBeInstanceOf(ValidationError);
    await expect(widerrufeEinladung(undefined)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("planAusEinladung", () => {
  it("liefert den Plan aus den Metadaten, wenn er existiert", async () => {
    expect(await planAusEinladung({ planId: "M" })).toBe("M");
    expect(await planAusEinladung({ planId: " S " })).toBe("S");
  });

  it("faellt auf null zurueck, wenn nichts Brauchbares dasteht", async () => {
    expect(await planAusEinladung(null)).toBeNull();
    expect(await planAusEinladung(undefined)).toBeNull();
    expect(await planAusEinladung({})).toBeNull();
    expect(await planAusEinladung({ planId: "" })).toBeNull();
    expect(await planAusEinladung({ planId: 3 })).toBeNull();
    // Der Plan wurde zwischen Einladung und Registrierung geloescht.
    expect(await planAusEinladung({ planId: "XXL" })).toBeNull();
  });
});
