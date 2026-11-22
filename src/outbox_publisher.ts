import { pool } from "./feed_db.js";
import { reviewQueue } from "./review_queue.js";

type OutboxRow = {
  id: string;
  delivery_id: string;
};

export async function publishOutboxBatch(): Promise<number> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<OutboxRow>(
      `SELECT id::text, delivery_id
       FROM review_outbox
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT 50
       FOR UPDATE SKIP LOCKED`,
    );

    for (const row of result.rows) {
      await reviewQueue.add(
        "review",
        { deliveryId: row.delivery_id },
        {
          jobId: row.delivery_id,
          attempts: 4,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
      );

      await client.query(
        `UPDATE review_outbox
         SET published_at = NOW(),
             publish_attempts = publish_attempts + 1,
             last_error = NULL
         WHERE id = $1`,
        [row.id],
      );

      await client.query(
        `UPDATE webhook_deliveries
         SET status = 'queued'
         WHERE delivery_id = $1 AND status = 'received'`,
        [row.delivery_id],
      );

      await client.query(
        `UPDATE review_jobs
         SET status = 'queued', updated_at = NOW()
         WHERE delivery_id = $1 AND status = 'pending'`,
        [row.delivery_id],
      );
    }

    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
