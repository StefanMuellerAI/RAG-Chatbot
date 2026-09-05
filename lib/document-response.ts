/** Helpers for authenticated PDF/audio delivery. No storage or user input is buffered here. */
export type ByteRange = { start: number; end: number };

export function parseByteRange(header: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0 || header.length > 128) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function inlineContentType(filename: string, declared: string, stored: string): string | null {
  const clean = (type: string) => type.split(";", 1)[0].trim().toLowerCase();
  const types = [clean(declared), clean(stored)];
  if (/\.pdf$/i.test(filename) && types.every((type) => type === "application/pdf")) return "application/pdf";
  if (/\.mp3$/i.test(filename) && types.every((type) => ["audio/mpeg", "audio/mp3"].includes(type))) return "audio/mpeg";
  return null;
}

export function ifRangeMatches(value: string | null, etag: string, uploadedAt: Date): boolean {
  if (!value) return true;
  if (value.startsWith('"')) return value === etag && !etag.startsWith("W/");
  if (value.startsWith("W/")) return false;
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.floor(uploadedAt.getTime() / 1000) <= Math.floor(date / 1000);
}
