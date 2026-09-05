import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = { id: "chat-a", titel: "Frage", titelManuell: false, geaendertAm: "2026-01-01" };
const message = { id: "answer-a", requestId: "request-a", role: "assistant", content: "Gespeichert", status: "completed" };
function json(value: unknown, status = 200) { return Response.json(value, { status }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let store: typeof import("@/lib/chatVerlauf");
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  store = await import("@/lib/chatVerlauf");
});
afterEach(() => vi.unstubAllGlobals());

describe("paginated chat browser cache", () => {
  it("keeps loading distinct from an empty chat, then exposes a retryable error", async () => {
    const response = deferred<Response>();
    fetcher.mockReturnValueOnce(response.promise);
    const opening = store.waehleChat(chat.id);
    expect(store.getSnapshot().aktiveId).toBe(chat.id);
    expect(store.getSnapshot().chatLadestand[chat.id].status).toBe("loading");
    response.resolve(json({ error: "Nicht erreichbar" }, 503));
    await opening;
    expect(store.getSnapshot().chatLadestand[chat.id]).toMatchObject({ status: "error", fehler: "Nicht erreichbar" });
    fetcher.mockResolvedValueOnce(json({ chat, messages: [message], nextCursor: null }));
    await store.ladeNachrichten(chat.id, true);
    expect(store.getSnapshot().chatLadestand[chat.id].status).toBe("ready");
    expect(store.nachrichtenVon(chat.id)[0].id).toBe(message.id);
  });
  it("deduplicates concurrent history fetches and prepends only new older messages", async () => {
    fetcher.mockResolvedValueOnce(json({ chat, messages: [message], nextCursor: "older" }));
    const a = store.ladeNachrichten(chat.id);
    const b = store.ladeNachrichten(chat.id);
    await Promise.all([a, b]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(json({ messages: [{ ...message, id: "old" }, message], nextCursor: null }));
    await store.ladeNachrichten(chat.id, false, true);
    expect(fetcher.mock.calls[1][0]).toContain("before=older");
    expect(store.nachrichtenVon(chat.id).map((n) => n.id)).toEqual(["old", "answer-a"]);
  });
  it("keeps a partial recovery copy when refreshing the server fails", async () => {
    store.merkeAntwort(chat.id, [{ ...message, role: "assistant", status: "aborted", content: "Bisheriger Text" }]);
    fetcher.mockRejectedValueOnce(new Error("offline"));
    expect(await store.ladeNachrichten(chat.id, true)).toBe(false);
    expect(store.nachrichtenVon(chat.id)[0].content).toBe("Bisheriger Text");
    expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });
  it("does not reuse an existing conversation that has not finished loading as a new chat", async () => {
    fetcher.mockResolvedValueOnce(json({ chats: [chat], nextCursor: null }));
    await store.initialisiere("alice");
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const loading = store.waehleChat(chat.id);
    fetcher.mockResolvedValueOnce(json({ chat: { ...chat, id: "new-chat" } }, 201));
    expect(await store.neuerChat()).toBe("new-chat");
    pending.resolve(json({ messages: [message] }));
    await loading;
    expect(store.getSnapshot().aktiveId).toBe("new-chat");
  });
  it("deduplicates simultaneous first-chat creation", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const a = store.neuerChat(); const b = store.neuerChat();
    pending.resolve(json({ chat }, 201));
    expect(await Promise.all([a, b])).toEqual([chat.id, chat.id]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not navigate back to a new chat if the user left while creation was pending", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const creating = store.neuerChat();
    await store.waehleChat(null);
    pending.resolve(json({ chat }, 201));
    await creating;
    expect(store.getSnapshot().aktiveId).toBeNull();
    expect(store.getSnapshot().chats[0].id).toBe(chat.id);
  });
  it("keeps a newly created chat when an older list response arrives afterwards", async () => {
    const pending = deferred<Response>();
    fetcher.mockReturnValueOnce(pending.promise);
    const loading = store.initialisiere("alice");
    fetcher.mockResolvedValueOnce(json({ chat }, 201));
    await store.neuerChat();
    pending.resolve(json({ chats: [], nextCursor: null }));
    await loading;
    expect(store.getSnapshot().chats[0].id).toBe(chat.id);
  });
  it("ignores late data from an account that signed out", async () => {
    const alice = deferred<Response>();
    fetcher.mockReturnValueOnce(alice.promise);
    const old = store.initialisiere("alice");
    fetcher.mockResolvedValueOnce(json({ chats: [{ ...chat, id: "bob-chat" }], nextCursor: null }));
    await store.initialisiere("bob");
    alice.resolve(json({ chats: [chat], nextCursor: null }));
    await old;
    expect(store.getSnapshot().chats.map((c) => c.id)).toEqual(["bob-chat"]);
  });
  it("loads the next chat page and does not remove a conversation on a rejected delete", async () => {
    fetcher.mockResolvedValueOnce(json({ chats: [chat], nextCursor: "page-2" }));
    await store.initialisiere("alice");
    fetcher.mockResolvedValueOnce(json({ chats: [{ ...chat, id: "older-chat" }, chat], nextCursor: null }));
    await store.ladeWeitereChats();
    expect(fetcher.mock.calls[1][0]).toContain("before=page-2");
    expect(store.getSnapshot().chats).toHaveLength(2);
    fetcher.mockResolvedValueOnce(json({ error: "Keine Verbindung" }, 503));
    await store.loeschen(chat.id);
    expect(store.getSnapshot().chats).toHaveLength(2);
    expect(store.getSnapshot().fehler).toBe("Keine Verbindung");
  });
});
