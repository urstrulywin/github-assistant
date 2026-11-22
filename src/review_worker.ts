import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "./redis.js";
import { pool, safeErrorMessage } from "./feed_db.js";

type ReviewJobData = {
  deliveryId: string;
};

type DeliveryRow = {
  payload: unknown;
};

async function runReview(_payload: unknown): Promise<void> {
  throw new Error(
    "Review processing is not implemented yet; refusing to mark job complete",
  );
}

export const worker = new Worker<ReviewJobData>(
  "reviews",
  async (job) => {
    const { deliveryId } = job.data;

    console.log("Processing review job", {
      deliveryId: job.data.deliveryId,
    });

    const result = await pool.query<DeliveryRow>(
      `SELECT payload
       FROM webhook_deliveries
       WHERE delivery_id = $1`,
      [deliveryId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error("Webhook delivery was not found");
    }

    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'processing', last_error = NULL
       WHERE delivery_id = $1`,
      [deliveryId],
    );

    await pool.query(
      `UPDATE review_jobs
       SET status = 'processing',
           attempts = attempts + 1,
           updated_at = NOW(),
           last_error = NULL
       WHERE delivery_id = $1`,
      [deliveryId],
    );

    try {
      await runReview(row.payload);

      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'completed',
             processed_at = NOW(),
             last_error = NULL
         WHERE delivery_id = $1`,
        [deliveryId],
      );

      await pool.query(
        `UPDATE review_jobs
         SET status = 'completed',
             completed_at = NOW(),
             updated_at = NOW(),
             last_error = NULL
         WHERE delivery_id = $1`,
        [deliveryId],
      );
    } catch (error) {
      // Store a generic summary rather than potentially sensitive API details.
      const message = safeErrorMessage(error);

      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'failed', last_error = $2
         WHERE delivery_id = $1`,
        [deliveryId, message],
      );

      await pool.query(
        `UPDATE review_jobs
         SET status = 'failed',
             updated_at = NOW(),
             last_error = $2
         WHERE delivery_id = $1`,
        [deliveryId, message],
      );

      throw error; // Required so BullMQ applies its retry policy.
    }
  },
  {
    connection: redis,
    concurrency: 3,
  },
);

worker.on("ready", () => {
  console.log("Review worker is ready");
});

worker.on("failed", (job, error) => {
  console.error("Review job failed", {
    deliveryId: job?.data.deliveryId,
    message: error.message,
  });
});
