import "dotenv/config";
import { readFile } from "node:fs/promises";
import { App } from "octokit";

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

const app = new App({
  appId,
  privateKey,
});

const octokit = await app.getInstallationOctokit(Number(installationId));

const { data: installation } = await octokit.request(
  "GET /installation/repositories",
  { per_page: 1 },
);

console.log("GitHub App authentication succeeded.");
console.log(
  "Accessible repositories:",
  installation.repositories.map((repo) => repo.full_name),
);
