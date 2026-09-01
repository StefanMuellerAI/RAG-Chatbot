import { NextResponse } from "next/server";
import { errorResponse, readJson, requireAdmin } from "@/lib/api";
import { createInvite, listInvites } from "@/lib/invites";

export const runtime = "nodejs";

/** Offene Einladungen (Admin). */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ invites: await listInvites() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Neue Einladung erzeugen (Admin). Der Link wird genau einmal zurueckgegeben. */
export async function POST(request: Request) {
  try {
    await requireAdmin();
    const { email } = await readJson<{ email: unknown }>(request);
    const { token, invite } = await createInvite(email);

    // Der Host kommt aus der Anfrage — so stimmt der Link auch auf Preview-Deployments.
    const link = new URL(`/einladung/${token}`, request.url).toString();
    return NextResponse.json({ invite, link });
  } catch (error) {
    return errorResponse(error);
  }
}
