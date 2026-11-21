import "dotenv/config";
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getInstallationOctokit } from "./github.js";
import { reviewPullRequest } from "./review.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

// if (!webhookSecret) {
//   throw new Error("GITHUB_WEBHOOK_SECRET is not set");
// }

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
    const deliveryId = req.header("x-github-delivery");

    if (event !== "pull_request") {
      return res.status(200).send("Event ignored");
    }

    const payload = JSON.parse(req.body.toString("utf8")) as PullRequestPayload;

    const action = payload.action;

    if (!["opened", "reopened", "synchronize"].includes(action ?? "")) {
      return res.status(200).send("Pull request action ignored");
    }

    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const pullNumber = payload.pull_request?.number;

    if (!owner || !repo || !pullNumber) {
      console.error("Webhook is missing repository or PR details", {
        deliveryId,
      });
      return res.status(400).send("Missing pull request details");
    }

    // Acknowledge the webhook before doing API work. In production, put this
    // work on a background queue instead of keeping it in the request.
    res.status(200).send("Pull request accepted");

    try {
      const octokit = await getInstallationOctokit();

      const { data: files } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        },
      );

      console.log("Fetched pull request files", {
        deliveryId,
        action,
        repository: `${owner}/${repo}`,
        number: pullNumber,
        title: payload.pull_request?.title,
        url: payload.pull_request?.html_url,
        fileCount: files.length,
        files: files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patchAvailable: Boolean(file.patch),
        })),
      });

      const findings = await reviewPullRequest({
        repository: `${owner}/${repo}`,
        pullNumber,
        title: payload.pull_request?.title ?? "",
        files,
      });

      console.log("Claude review finished which is: ", {
        repository: `${owner}/${repo}`,
        number: pullNumber,
        findingCount: findings.length,
        findings,
      });
    } catch (error) {
      console.error("Failed to fetch pull request files", {
        deliveryId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.get("/health", (_req, res) => {
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`Webhook server listening on port ${port}`);
});
