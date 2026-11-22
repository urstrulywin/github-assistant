import "dotenv/config";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { initializeDatabase, recordDelivery } from "./feed_db.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

if (!webhookSecret) {
  throw new Error("GITHUB_WEBHOOK_SECRET is not set");
}

type PullRequestPayload = {
  action?: string;
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
    html_url?: string;
  };
};

app.post(
  "/api/github/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.header("x-hub-signature-256");

    if (!signature || !Buffer.isBuffer(req.body)) {
      return res.status(400).send("Missing signature or request body");
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
    if (event !== "pull_request") {
      return res.status(200).send("Event ignored");
    }

    const deliveryId = req.header("x-github-delivery");
    if (!deliveryId) {
      return res.status(400).send("Missing delivery ID");
    }

    console.info("GitHub webhook received", {
      event,
      deliveryId,
    });

    const payload = JSON.parse(req.body.toString("utf8")) as PullRequestPayload;

    const action = payload.action;

    if (!["opened", "reopened", "synchronize"].includes(action ?? "")) {
      return res.status(200).send("Pull request action ignored");
    }

    const installationId = payload.installation?.id;
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = payload.pull_request?.number;

    if (!installationId || !owner || !repo || !pullNumber) {
      return res
        .status(400)
        .send("Missing installation or pull request details");
    }

    console.info("Pull request webhook received", {
      deliveryId,
      action,
      repository: `${owner}/${repo}`,
      pullNumber,
    });

    try {
      const isNew = await recordDelivery({
        deliveryId,
        event,
        payload,
      });
      console.info("Webhook delivery recorded", {
        deliveryId,
        duplicate: !isNew,
      });

      return res
        .status(202)
        .send(isNew ? "Review accepted" : "Duplicate delivery ignored");
    } catch (error) {
      console.error("Could not queue review", {
        deliveryId,
        message: error instanceof Error ? error.message : String(error),
      });

      // A non-2xx response tells GitHub the delivery failed, so it can retry.
      return res.status(500).send("Could not queue review");
    }
  },
);

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

async function startServer(): Promise<void> {
  // initializeDatabase() runs every time the server starts, so it can be used to create tables if they don't exist
  // should be changed so that it only runs once
  await initializeDatabase();

  app.listen(port, () => {
    console.log(`Webhook server listening on port ${port}`);
  });
}

void startServer().catch((error) => {
  console.error(
    "Server startup failed",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});

// app.listen(port, () => {
//   console.log(`Webhook server listening on port ${port}`);
// });
