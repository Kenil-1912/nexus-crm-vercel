import 'dotenv/config';
import pg from 'pg';

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates (avoids time-zone shifts).
pg.types.setTypeParser(1082, (value) => value);

// DATABASE_SSL=true for Supabase (and any hosted database). The certificate is
// not checked against a CA here; download Supabase's CA certificate and pass it
// as ssl.ca if you need full verification.
const ssl = process.env.DATABASE_SSL === 'true';
let connectionString = process.env.DATABASE_URL || 'postgres://nexus:nexus@localhost:5432/nexus_crm';
if (ssl) {
  // An sslmode in the URL would override the ssl option below, so drop it.
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  connectionString = url.toString();
}

export const pool = new pg.Pool({
  connectionString,
  ssl: ssl ? { rejectUnauthorized: false } : undefined,
  // On Vercel each function instance keeps its own pool: keep it small and use
  // Supabase's transaction pooler (port 6543). Locally the default of 10 is fine.
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 10_000,
});

export const query = (text, params) => pool.query(text, params);

/** Run fn inside one transaction; rolls back if fn throws. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
