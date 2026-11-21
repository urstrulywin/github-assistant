import "dotenv/config";
import { readFile } from "node:fs/promises";
import { App } from "octokit";

async function main() {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !installationId || !privateKeyPath) {
    throw new Error(
      "Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and " +
        "GITHUB_PRIVATE_KEY_PATH in .env",
    );
  }

  const privateKey = await readFile(privateKeyPath, "utf8");
  const app = new App({ appId, privateKey });
  const octokit = await app.getInstallationOctokit(Number(installationId));

  const owner = "urstrulywin";
  const repo = "github-assistant-test";
  const pullNumber = 2;

  const { data: files } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    },
  );

  console.log(`Changed files in PR #${pullNumber}:`);

  for (const file of files) {
    console.log({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailable: Boolean(file.patch),
      patch: file.patch,
    });
  }
}

main().catch((error: unknown) => {
  console.error("Could not fetch pull-request files.");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
