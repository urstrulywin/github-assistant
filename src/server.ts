import "dotenv/config";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error("GITHUB_WEBHOOK_SECRET is not set");
}

app.post(
  "/api/github/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.header("x-hub-signature-256");

    if (!signature || !Buffer.isBuffer(req.body)) {
      return res.status(400).send("Missing signature or body");
    }

    const expected =
      "sha256=" +
      createHmac("sha256", webhookSecret).update(req.body).digest("hex");

    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);

    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.header("x-github-event");
    const deliveryId = req.header("x-github-delivery");

    console.log("Verified GitHub webhook", {
      event,
      deliveryId,
    });

    return res.status(200).send("Webhook received");
  },
);

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
