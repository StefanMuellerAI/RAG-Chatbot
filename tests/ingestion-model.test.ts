import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  generateText: vi.fn(), reserveModelCall: vi.fn(), setDescription: vi.fn(),
  collection: vi.fn(), files: vi.fn(),
}));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), generateText: mocks.generateText }));
vi.mock("@/lib/ai", async (original) => ({ ...await original<typeof import("@/lib/ai")>(), modell: async () => "test/model" }));
vi.mock("@/lib/capacity", async (original) => ({
  ...await original<typeof import("@/lib/capacity")>(),
  reserveModelCall: mocks.reserveModelCall,
  withIngestionCapacity: async (work: (context: { signal: AbortSignal }) => Promise<unknown>) => work({ signal: new AbortController().signal }),
}));
vi.mock("@/lib/collections", async (original) => ({ ...await original<typeof import("@/lib/collections")>(), setzeAutoBeschreibung: mocks.setDescription }));
vi.mock("@/lib/db", () => ({ getDb: () => ({
  query: { collections: { findFirst: mocks.collection } },
  select: () => ({ from: () => ({ where: () => ({ limit: mocks.files }) }) }),
}) }));
import { ergaenzeBeschreibung } from "@/workflows/ingest";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collection.mockResolvedValue({ name: "Knowledge", description: "", descriptionSource: "auto" });
  mocks.files.mockResolvedValue(Array.from({ length: 25 }, () => ({ filename: "x".repeat(500) })));
  mocks.generateText.mockResolvedValue({ text: "A short description" });
  mocks.reserveModelCall.mockResolvedValue(undefined);
  mocks.setDescription.mockResolvedValue(undefined);
});

describe("bounded collection descriptions", () => {
  it("reserves upload/provider capacity before one bounded model call", async () => {
    await ergaenzeBeschreibung("collection_1");
    expect(mocks.reserveModelCall).toHaveBeenCalledWith(expect.any(String), expect.any(Number), { pool: "ingestion", signal: expect.any(AbortSignal) });
    expect(mocks.reserveModelCall.mock.invocationCallOrder[0]).toBeLessThan(mocks.generateText.mock.invocationCallOrder[0]);
    const options = mocks.generateText.mock.calls[0][0];
    expect(options).toMatchObject({ maxOutputTokens: 256, maxRetries: 0, abortSignal: expect.any(AbortSignal) });
    expect(options.prompt.length).toBeLessThan(6000);
    expect(mocks.setDescription).toHaveBeenCalledWith("collection_1", "A short description");
  });

  it("does not call the provider or write a description when capacity is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.reserveModelCall.mockRejectedValueOnce(new Error("Capacity unavailable"));
    try {
      await ergaenzeBeschreibung("collection_1");
      expect(mocks.generateText).not.toHaveBeenCalled();
      expect(mocks.setDescription).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
});
