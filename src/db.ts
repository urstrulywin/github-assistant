import "dotenv/config";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({ connectionString });

const schemaSql = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'received'
      CHECK (status IN ('received', 'queued', 'processing', 'completed', 'failed')),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS review_jobs (
    id BIGSERIAL PRIMARY KEY,
    delivery_id TEXT NOT NULL UNIQUE
      REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS review_outbox (
    id BIGSERIAL PRIMARY KEY,
    delivery_id TEXT NOT NULL UNIQUE
      REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS review_results (
    delivery_id TEXT PRIMARY KEY
      REFERENCES webhook_deliveries(delivery_id) ON DELETE CASCADE,
    findings JSONB NOT NULL,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS review_outbox_unpublished_idx
    ON review_outbox (id)
    WHERE published_at IS NULL;
`;

export async function initializeDatabase(): Promise<void> {
  await pool.query(schemaSql);
}

/**
 * Records a webhook and creates its review job/outbox row atomically.
 * Returns false for a duplicate GitHub delivery ID.
 */
export async function recordDelivery(input: {
  deliveryId: string;
  event: string;
  payload: unknown;
}): Promise<boolean> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [input.deliveryId, input.event, JSON.stringify(input.payload)],
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(`INSERT INTO review_jobs (delivery_id) VALUES ($1)`, [
      input.deliveryId,
    ]);

    await client.query(`INSERT INTO review_outbox (delivery_id) VALUES ($1)`, [
      input.deliveryId,
    ]);

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveReviewResult(input: {
  deliveryId: string;
  findings: unknown;
  model: string | undefined;
}): Promise<void> {
  await pool.query(
    `INSERT INTO review_results (delivery_id, findings, model)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (delivery_id)
     DO UPDATE SET
       findings = EXCLUDED.findings,
       model = EXCLUDED.model,
       created_at = NOW()`,
    [input.deliveryId, JSON.stringify(input.findings), input.model ?? null],
  );
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/**
 * Use this only for known-safe error summaries. Do not pass raw request
 * payloads, source code, credentials, or full provider responses here.
 */
export function safeErrorMessage(_error: unknown): string {
  return "Review processing failed; see sanitized application logs";
}
