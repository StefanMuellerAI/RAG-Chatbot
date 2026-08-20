import { errorResponse, readJson } from "@/lib/api";
import { requireKontext } from "@/lib/auth/user";
import { erstelleSammlung, ladeSammlungen, type SammlungEingabe } from "@/lib/collections";

export const runtime = "nodejs";

/** Die Sammlungen des angemeldeten Nutzers. */
export async function GET() {
  try {
    const kontext = await requireKontext();
    return Response.json({ sammlungen: await ladeSammlungen(kontext.userId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const kontext = await requireKontext();
    const eingabe = await readJson<SammlungEingabe>(request);

    const sammlung = await erstelleSammlung(kontext, eingabe);
    return Response.json({ sammlung }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
