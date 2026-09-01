import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api";
import { testModel } from "@/lib/llm";
import { PROVIDER_LABEL, isProvider, resolveApiKey } from "@/lib/settings";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Prueft Key und Modell-ID mit einem minimalen Aufruf beim Anbieter. */
export async function POST(request: Request) {
  const body = await readJson<{ provider: unknown; model: unknown; apiKey: unknown }>(request);

  if (!isProvider(body.provider)) {
    return NextResponse.json({ error: "Unbekannter Anbieter." }, { status: 400 });
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return NextResponse.json({ error: "Bitte zuerst ein Modell auswaehlen." }, { status: 400 });
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

    const result = await testModel({ provider: body.provider, model, apiKey });
    return result.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  } catch (error) {
    return errorResponse(error);
  }
}
