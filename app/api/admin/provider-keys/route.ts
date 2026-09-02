import { errorResponse, readJson } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { providerKeySecretKonfiguriert } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { istKeyAnbieter } from "@/lib/models";
import { ladeKeyStatus, loescheKey, speichereKey } from "@/lib/provider-keys";

export const runtime = "nodejs";

/** Status je Anbieter: nur Maske und Zeitpunkt, nie der Key. */
export async function GET() {
  try {
    await requireAdmin();
    return Response.json({
      keys: await ladeKeyStatus(),
      secretKonfiguriert: providerKeySecretKonfiguriert(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Key eines Anbieters hinterlegen oder ersetzen. */
export async function PUT(request: Request) {
  try {
    await requireAdmin();

    const eingabe = await readJson<{ provider?: unknown; key?: unknown }>(request);
    if (!istKeyAnbieter(eingabe.provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind Anthropic und OpenAI.");
    }
    if (typeof eingabe.key !== "string") {
      throw new ValidationError("Es wurde kein API-Key uebermittelt.");
    }

    await speichereKey(eingabe.provider, eingabe.key);
    return Response.json({ ok: true, keys: await ladeKeyStatus() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin();

    const provider = new URL(request.url).searchParams.get("provider");
    if (!istKeyAnbieter(provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind Anthropic und OpenAI.");
    }

    await loescheKey(provider);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
