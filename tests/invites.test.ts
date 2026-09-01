import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", async () => {
  const { fakeRedis } = await import("./helpers/fakeRedis");
  return { getRedis: () => fakeRedis };
});
// Sammlungen werden beim Loeschen eines Nutzers kaskadiert — hier nicht Gegenstand.
vi.mock("@/lib/collections", () => ({ deleteCollectionsOf: async () => 0 }));

import { hashes, reset } from "./helpers/fakeRedis";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { acceptInvite, createInvite, getInviteByToken, listInvites, revokeInvite } from "@/lib/invites";
import { verifyPassword } from "@/lib/password";
import { findUserByEmail } from "@/lib/users";

beforeEach(() => {
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Einladungen", () => {
  it("speichert nur den Hash des Tokens", async () => {
    const { token, invite } = await createInvite("  Anna@Beispiel.DE ");
    expect(invite.email).toBe("anna@beispiel.de");
    expect(invite.id).not.toBe(token);

    const roh = [...(hashes.get("invites")?.values() ?? [])].join("\n");
    expect(roh).not.toContain(token);
    expect(roh).toContain(invite.id);
  });

  it("findet die Einladung zum Token, nicht zu einem falschen", async () => {
    const { token } = await createInvite("b@beispiel.de");
    expect((await getInviteByToken(token))?.email).toBe("b@beispiel.de");
    expect(await getInviteByToken(`${token}x`)).toBeNull();
    expect(await getInviteByToken("")).toBeNull();
  });

  it("lehnt ungueltige Adressen ab", async () => {
    await expect(createInvite("kein-mail")).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvite(42)).rejects.toBeInstanceOf(ValidationError);
  });

  it("legt beim Annehmen das Konto an und verbraucht die Einladung", async () => {
    const { token } = await createInvite("c@beispiel.de");
    const user = await acceptInvite(token, "sicheres-passwort-1");

    expect(user.email).toBe("c@beispiel.de");
    expect(user).not.toHaveProperty("passwordHash");

    const gespeichert = await findUserByEmail("C@beispiel.de");
    expect(gespeichert).not.toBeNull();
    expect(await verifyPassword("sicheres-passwort-1", gespeichert!.passwordHash)).toBe(true);

    await expect(acceptInvite(token, "sicheres-passwort-1")).rejects.toBeInstanceOf(NotFoundError);
    expect(await listInvites()).toEqual([]);
  });

  it("laedt keine Adresse ein, die schon ein Konto hat", async () => {
    const { token } = await createInvite("d@beispiel.de");
    await acceptInvite(token, "sicheres-passwort-1");
    await expect(createInvite("d@beispiel.de")).rejects.toThrow(/bereits ein Konto/);
  });

  it("laesst abgelaufene Einladungen verfallen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    const { token } = await createInvite("e@beispiel.de");

    vi.setSystemTime(new Date("2026-03-09T10:00:00Z"));
    expect(await getInviteByToken(token)).toBeNull();
    expect(await listInvites()).toEqual([]);
    expect(hashes.get("invites")?.size ?? 0).toBe(0);
  });

  it("laesst sich widerrufen", async () => {
    const { token, invite } = await createInvite("f@beispiel.de");
    expect(await revokeInvite(invite.id)).toBe(true);
    expect(await getInviteByToken(token)).toBeNull();
    expect(await revokeInvite(invite.id)).toBe(false);
  });

  it("sortiert offene Einladungen nach Erstellung, neueste zuerst", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
    await createInvite("alt@beispiel.de");
    vi.setSystemTime(new Date("2026-03-01T11:00:00Z"));
    await createInvite("neu@beispiel.de");
    expect((await listInvites()).map((invite) => invite.email)).toEqual(["neu@beispiel.de", "alt@beispiel.de"]);
  });
});

describe("Fehlerklassen", () => {
  it("sind unterscheidbar", () => {
    expect(new ForbiddenError()).toBeInstanceOf(Error);
    expect(new ForbiddenError().name).toBe("ForbiddenError");
  });
});
