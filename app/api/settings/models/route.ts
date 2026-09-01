import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api";
import { listModels } from "@/lib/models";
import { PROVIDER_LABEL, isProvider, resolveApiKey } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Holt die Modell-Liste vom Anbieter. `apiKey` ist optional: Ist er gesetzt,
 * wird der frisch eingegebene Key benutzt (noch vor dem Speichern), sonst der
 * gespeicherte bzw. der aus der Umgebung.
 */
export async function POST(request: Request) {
  const body = await readJson<{ provider: unknown; apiKey: unknown }>(request);

  if (!isProvider(body.provider)) {
    return NextResponse.json({ error: "Unbekannter Anbieter." }, { status: 400 });
  }

  try {
    const apiKey = await resolveApiKey(
      body.provider,
      typeof body.apiKey === "string" ? body.apiKey : undefined,
    );
    if (!apiKey) {
      return NextResponse.json(
        { error: `Fuer ${PROVIDER_LABEL[body.provider]} ist noch kein API-Key eingetragen.` },
        { status: 400 },
      );
    }

    const models = await listModels(body.provider, apiKey);
    return NextResponse.json({ models });
  } catch (error) {
    return errorResponse(error);
  }
}
