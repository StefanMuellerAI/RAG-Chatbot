import {
  verfuegbareModelleVomGateway,
  verfuegbareModelleVonAnbieter,
} from "@/lib/anbieter-modelle";
import { errorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/user";
import { ValidationError } from "@/lib/errors";
import { ANBIETER_LABEL, istAnbieter, istKeyAnbieter } from "@/lib/models";
import { ladeKey } from "@/lib/provider-keys";

export const runtime = "nodejs";

/**
 * Was der Admin in den Katalog aufnehmen kann: die Modell-Liste des Anbieters
 * (mit hinterlegtem Key) bzw. die Sprachmodelle des Gateway-Katalogs, jeweils
 * mit vorbelegten Preisen aus dem oeffentlichen Gateway-Katalog.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();

    const provider = new URL(request.url).searchParams.get("provider");
    if (!istAnbieter(provider)) {
      throw new ValidationError("Unbekannter Anbieter. Zulaessig sind gateway, anthropic und openai.");
    }

    if (!istKeyAnbieter(provider)) {
      return Response.json({ modelle: await verfuegbareModelleVomGateway() });
    }

    const apiKey = await ladeKey(provider);
    if (!apiKey) {
      throw new ValidationError(
        `Fuer ${ANBIETER_LABEL[provider]} ist kein API-Key hinterlegt. Die Modell-Liste laesst sich erst mit Key laden.`,
      );
    }

    return Response.json({ modelle: await verfuegbareModelleVonAnbieter(provider, apiKey) });
  } catch (error) {
    return errorResponse(error);
  }
}
