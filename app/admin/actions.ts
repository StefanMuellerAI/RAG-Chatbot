"use server";

import { headers } from "next/headers";
import {
  aendereNutzer,
  loeschePlan,
  loescheModell,
  normalisiereGroessenklasseEingabe,
  normalisiereModellEingabe,
  normalisiereNutzerAenderung,
  normalisierePlanEingabe,
  pruefeModellKennung,
  pruefePlanKennung,
  speichereGroessenklasse,
  speichereModell,
  speicherePlan,
} from "@/lib/admin";
import { alsAktion, type AktionsErgebnis } from "@/lib/aktionen";
import { requireAdmin } from "@/lib/auth/user";
import { erstelleEinladung, widerrufeEinladung, type Einladung } from "@/lib/einladungen";
import { ValidationError } from "@/lib/errors";
import { istKeyAnbieter } from "@/lib/models";
import { loescheKey, speichereKey } from "@/lib/provider-keys";

/**
 * Server Actions der Administration.
 *
 * Jede Action prueft die Rolle selbst — der Proxy stellt nur sicher, dass
 * ueberhaupt jemand angemeldet ist, und das genuegt hier nicht. Die Argumente
 * kommen ungeprueft vom Client und werden deshalb wie ein Request-Body
 * behandelt: `unknown` hinein, gepruefte Eingabe heraus (lib/admin.ts).
 *
 * `alsAktion` rendert nach Erfolg die Admin-Seite im selben Roundtrip neu;
 * die Konsole braucht kein router.refresh() mehr.
 */

export async function speichereGroessenklasseAktion(eingabe: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await speichereGroessenklasse(normalisiereGroessenklasseEingabe(eingabe));
  });
}

export async function speicherePlanAktion(eingabe: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await speicherePlan(normalisierePlanEingabe(eingabe));
  });
}

export async function loeschePlanAktion(planId: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await loeschePlan(pruefePlanKennung(planId));
  });
}

export async function speichereModellAktion(eingabe: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await speichereModell(normalisiereModellEingabe(eingabe));
  });
}

export async function loescheModellAktion(id: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await loescheModell(pruefeModellKennung(id));
  });
}

export async function speichereProviderKeyAktion(eingabe: {
  provider: unknown;
  key: unknown;
}): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    if (!istKeyAnbieter(eingabe.provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind Anthropic und OpenAI.");
    }
    if (typeof eingabe.key !== "string") {
      throw new ValidationError("Es wurde kein API-Key uebermittelt.");
    }
    await speichereKey(eingabe.provider, eingabe.key);
  });
}

export async function loescheProviderKeyAktion(provider: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    if (!istKeyAnbieter(provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind Anthropic und OpenAI.");
    }
    await loescheKey(provider);
  });
}

export async function aendereNutzerAktion(eingabe: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    const admin = await requireAdmin();
    await aendereNutzer(normalisiereNutzerAenderung(eingabe), admin.userId);
  });
}

export async function erstelleEinladungAktion(eingabe: {
  email: unknown;
  planId: unknown;
}): Promise<AktionsErgebnis<Einladung>> {
  return alsAktion(async () => {
    await requireAdmin();
    return erstelleEinladung({
      email: eingabe.email,
      planId: eingabe.planId,
      appUrl: await eigeneAdresse(),
    });
  });
}

export async function widerrufeEinladungAktion(id: unknown): Promise<AktionsErgebnis<void>> {
  return alsAktion(async () => {
    await requireAdmin();
    await widerrufeEinladung(id);
  });
}

/**
 * Der Sign-up-Link muss auf DIESE Instanz zeigen (Vorschau, Produktion).
 * Browser schicken bei Actions den Origin mit; faellt er aus, reicht der Host
 * samt Protokoll, wie der Proxy von Vercel ihn weitergibt.
 */
async function eigeneAdresse(): Promise<string> {
  const kopf = await headers();
  const origin = kopf.get("origin");
  if (origin) return origin;
  const protokoll = kopf.get("x-forwarded-proto") ?? "https";
  return `${protokoll}://${kopf.get("host") ?? ""}`;
}
