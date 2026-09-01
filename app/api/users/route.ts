import { NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/api";
import { listCollections } from "@/lib/collections";
import { listUsers } from "@/lib/users";

export const runtime = "nodejs";

/** Alle Nutzerkonten mit der Zahl ihrer Sammlungen (Admin). */
export async function GET() {
  try {
    await requireAdmin();
    const [users, collections] = await Promise.all([listUsers(), listCollections()]);

    const anzahl = new Map<string, number>();
    for (const collection of collections) {
      anzahl.set(collection.ownerId, (anzahl.get(collection.ownerId) ?? 0) + 1);
    }

    return NextResponse.json({
      users: users.map((user) => ({ ...user, collectionCount: anzahl.get(user.id) ?? 0 })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
