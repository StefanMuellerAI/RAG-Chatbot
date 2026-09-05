import type { Server } from "node:http";
import type { SqlExecutor } from "./executor.mjs";
export function createSqlServer(options: { token: string; executor?: SqlExecutor }): Server;
