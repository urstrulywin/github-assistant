import { publishOutboxBatch } from "./outbox_publisher.js";

async function runPublisher(): Promise<void> {
  while (true) {
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

void runPublisher();
