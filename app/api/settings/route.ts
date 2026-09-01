import { NextResponse } from "next/server";
import { errorResponse, readJson } from "@/lib/api";
import {
  MAX_DAILY_ANSWER_LIMIT,
  PROVIDERS,
  getPublicSettings,
  isProvider,
  updateSettings,
  type Provider,
  type SettingsUpdate,
} from "@/lib/settings";

export const runtime = "nodejs";

/** Modell-IDs der Anbieter: Buchstaben, Ziffern, Punkt, Bindestrich, Unterstrich, Doppelpunkt, Schraegstrich. */
const MODEL_ID = /^[A-Za-z0-9._:\/-]{1,120}$/;

/** Einstellungen in der Form, die der Browser sehen darf (Keys maskiert). */
export async function GET() {
  try {
    return NextResponse.json({ settings: await getPublicSettings() });
  } catch (error) {
    return errorResponse(error);
  }
}

type Body = {
  provider?: unknown;
  model?: unknown;
  dailyAnswerLimit?: unknown;
  dailyAnswerLimitPerUser?: unknown;
  keys?: Partial<Record<Provider, unknown>>;
};

/** Speichert Provider, Modell, Tagesbudget und optional neue oder geloeschte Keys. */
export async function PUT(request: Request) {
  const body = await readJson<Body>(request);

  if (!isProvider(body.provider)) {
    return NextResponse.json({ error: "Unbekannter Anbieter." }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !MODEL_ID.test(model)) {
    return NextResponse.json({ error: "Die Modell-ID enthaelt unzulaessige Zeichen." }, { status: 400 });
  }

  const dailyAnswerLimit = Number(body.dailyAnswerLimit);
  if (!Number.isInteger(dailyAnswerLimit) || dailyAnswerLimit < 1 || dailyAnswerLimit > MAX_DAILY_ANSWER_LIMIT) {
    return NextResponse.json(
      { error: `Das Tagesbudget muss eine ganze Zahl zwischen 1 und ${MAX_DAILY_ANSWER_LIMIT} sein.` },
      { status: 400 },
    );
  }

  // Leer, null oder 0 bedeutet: kein eigenes Limit pro Nutzer.
  let dailyAnswerLimitPerUser: number | null = null;
  if (body.dailyAnswerLimitPerUser !== undefined && body.dailyAnswerLimitPerUser !== null && body.dailyAnswerLimitPerUser !== "") {
    const wert = Number(body.dailyAnswerLimitPerUser);
    if (!Number.isInteger(wert) || wert < 0 || wert > MAX_DAILY_ANSWER_LIMIT) {
      return NextResponse.json(
        { error: `Das Limit pro Nutzer muss eine ganze Zahl zwischen 0 und ${MAX_DAILY_ANSWER_LIMIT} sein.` },
        { status: 400 },
      );
    }
    dailyAnswerLimitPerUser = wert > 0 ? wert : null;
  }

  const keys: SettingsUpdate["keys"] = {};
  for (const provider of PROVIDERS) {
    const value = body.keys?.[provider];
    if (value === undefined) continue;
    if (value === null || typeof value === "string") {
      keys[provider] = value;
    } else {
      return NextResponse.json({ error: "Ungueltiger API-Key." }, { status: 400 });
    }
  }

  try {
    const settings = await updateSettings({
      provider: body.provider,
      model,
      dailyAnswerLimit,
      dailyAnswerLimitPerUser,
      keys,
    });
    return NextResponse.json({ settings });
  } catch (error) {
    return errorResponse(error);
  }
}
