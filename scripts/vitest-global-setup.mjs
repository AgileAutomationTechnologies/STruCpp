import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

export default function setup() {
  execFileSync(process.execPath, ["scripts/rebuild-libs.mjs"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
}
