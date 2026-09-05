export const SQL_MAX_BYTES: number;
export const SQL_MAX_ROWS: number;
export const SQL_MAX_QUERY_CHARS: number;
export const SQL_MAX_RESULT_BYTES: number;
export type SqlCollection = { userId: string; id: string; sqlBlobPath: string };
export function assertCollection(collection: unknown): SqlCollection;
export function assertReadOnlySql(sql: unknown): string;
