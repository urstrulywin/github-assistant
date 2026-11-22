import { Queue } from "bullmq";
import { redis } from "./redis.js";

export const reviewQueue = new Queue("reviews", {
  connection: redis,
});

export async function closeQueue(): Promise<void> {
  await reviewQueue.close();
}
