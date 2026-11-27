import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var nbaPool: Pool | undefined;
}

export const pool = global.nbaPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

if (process.env.NODE_ENV !== "production") global.nbaPool = pool;