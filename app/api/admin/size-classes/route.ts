import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import {
  ladeGroessenklassen,
  speichereGroessenklasse,
  type GroessenklasseEingabe,
} from "@/lib/admin";
import { ValidationError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json({ groessenklassen: await ladeGroessenklassen() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Anlegen oder aendern einer Groessenklasse. */
export async function PUT(request: Request) {
  try {
    // Jede Admin-Route prueft die Rolle selbst. Der Proxy stellt nur sicher,
    // dass ueberhaupt jemand angemeldet ist - das genuegt hier nicht.
    await requireAdmin();

    const eingabe = await readJson<Partial<GroessenklasseEingabe>>(request);

    if (typeof eingabe.id !== "string" || !/^[A-Za-z0-9_-]{1,8}$/.test(eingabe.id)) {
      throw new ValidationError(
        "Die Kennung muss aus 1 bis 8 Buchstaben, Ziffern, Binde- oder Unterstrichen bestehen.",
      );
    }

    await speichereGroessenklasse({
      id: eingabe.id,
      label: String(eingabe.label ?? ""),
      rank: Number(eingabe.rank),
      maxDocuments: Number(eingabe.maxDocuments),
      maxPagesPerDocument: Number(eingabe.maxPagesPerDocument),
      maxTotalPages: Number(eingabe.maxTotalPages),
      maxFileMegabytes: Number(eingabe.maxFileMegabytes),
    });

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
