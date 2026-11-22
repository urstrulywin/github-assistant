import "dotenv/config";
import { Worker } from "bullmq";
import { redis } from "./redis.js";
import { pool, safeErrorMessage, saveReviewResult } from "./feed_db.js";
import { getInstallationOctokit } from "./github.js";
import { reviewPullRequest } from "./review.js";

type ReviewJobData = {
  deliveryId: string;
};

type PullRequestPayload = {
  installation?: {
    id?: number;
  };
  repository?: {
    name?: string;
    owner?: {
      login?: string;
    };
  };
  pull_request?: {
    number?: number;
    title?: string;
  };
};

type DeliveryRow = {
  payload: PullRequestPayload;
};

async function runReview(
  deliveryId: string,
  payload: PullRequestPayload,
): Promise<void> {
  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const pullNumber = payload.pull_request?.number;
  const title = payload.pull_request?.title ?? "";

  if (!installationId || !owner || !repo || !pullNumber) {
    throw new Error("Stored webhook payload is missing required PR details");
  }

  const octokit = await getInstallationOctokit(installationId);

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const findings = await reviewPullRequest({
    repository: `${owner}/${repo}`,
    pullNumber,
    title,
    files: files.map((file) => ({
      filename: file.filename,
      status: file.status,
      patch: file.patch,
    })),
  });

  await saveReviewResult({
    deliveryId,
    findings,
    model: process.env.ANTHROPIC_MODEL,
  });

  console.info("Review finished", {
    deliveryId,
    repository: `${owner}/${repo}`,
    pullNumber,
    findingsCount: findings.length,
  });

  // This saves findings to Postgres only. It does not post comments to GitHub.
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
      await runReview(deliveryId, row.payload);

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
