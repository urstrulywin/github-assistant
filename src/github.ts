import { readFile } from "node:fs/promises";
import { App } from "octokit";

const appId = process.env.GITHUB_APP_ID;
const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

if (!appId || !privateKeyPath) {
  throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH must be set");
}

const privateKey = await readFile(privateKeyPath, "utf8");
const app = new App({ appId, privateKey });

export function getInstallationOctokit(installationId: number) {
  return app.getInstallationOctokit(installationId);
}
