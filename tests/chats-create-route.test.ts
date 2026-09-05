import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/auth/user", () => ({
  requireKontext: mocks.context,
  requireUserId: vi.fn(),
  NotSignedInError: class NotSignedInError extends Error {},
  NotAdminError: class NotAdminError extends Error {},
}));
vi.mock("@/lib/chat-pages", () => ({ chatPage: vi.fn(), pageSize: vi.fn() }));
vi.mock("@/lib/chats", () => ({
  erstelleChat: mocks.create, ladeChats: vi.fn(), loescheAlleChats: vi.fn(), uebernehmeVerlauf: vi.fn(),
}));
import { POST } from "@/app/api/chats/route";
import { NotSignedInError } from "@/lib/auth/user";

const userId = "user_authenticated_test_account";
const chat = { id: "11111111-1111-4111-8111-111111111111", title: "Lasttest" };
const request = () => new Request("https://test.invalid/api/chats", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ titel: "Lasttest", authenticatedUserId: "forged-account", userId: "forged-account" }),
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ userId });
  mocks.create.mockResolvedValue(chat);
});

describe("Chat-Anlage bestaetigt die eigene authentifizierte Identitaet", () => {
  it("liefert die Serveridentitaet neben dem unveraenderten Chat und ignoriert mitgesendete IDs", async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ chat, authenticatedUserId: userId });
    expect(mocks.create).toHaveBeenCalledWith(userId, "Lasttest");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("liefert unangemeldet keine Identitaet und legt keinen Chat an", async () => {
    mocks.context.mockRejectedValue(new NotSignedInError());
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("authenticatedUserId");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
