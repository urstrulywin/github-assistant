import "dotenv/config";
import { publishOutboxBatch } from "./outbox_publisher.js";
import { worker } from "./review_worker.js";
import { closeQueue } from "./review_queue.js";
import { closeDatabase } from "./feed_db.js";
import { redis } from "./redis.js";

let stopping = false;

async function runPublisher(): Promise<void> {
  while (!stopping) {
    try {
      const published = await publishOutboxBatch();

      if (published === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } catch (error) {
      console.error(
        "Outbox publishing failed",
        error instanceof Error ? error.message : "Unknown error",
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;

  console.log("Stopping publisher and worker");

  await worker.close();
  await closeQueue();
  await redis.quit();
  await closeDatabase();

  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.log("Starting publisher and worker");

void runPublisher();
