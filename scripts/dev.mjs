import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const children = [
  spawn("tsc", ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], {
    stdio: "inherit",
  }),
  spawn("vite", ["build", "--watch", "--config", "dashboard/vite.config.ts"], {
    stdio: "inherit",
  }),
];
const args = process.argv.slice(2);
let firstStart = true;

async function snapshot(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (directory === "dist" && entry.name === "dashboard") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await snapshot(path)));
    else {
      const info = await stat(path);
      files.push(`${path}:${info.mtimeMs}:${info.size}`);
    }
  }
  return files;
}

function run() {
  const runArgs = firstStart || args.includes("--no-open") ? args : [...args, "--no-open"];
  firstStart = false;
  return spawn(process.execPath, ["dist/cli.js", "dashboard", ...runArgs], {
    stdio: "inherit",
  });
}

let dashboard = run();
let previous = (await snapshot("dist")).sort().join("\n");
let restarting = false;

function stop() {
  dashboard.kill("SIGTERM");
  for (const child of children) child.kill("SIGTERM");
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

setInterval(async () => {
  if (restarting) return;
  const current = (await snapshot("dist")).sort().join("\n");
  if (current === previous) return;
  previous = current;
  restarting = true;
  dashboard.kill("SIGTERM");
  await new Promise((resolve) => dashboard.once("close", resolve));
  dashboard = run();
  restarting = false;
}, 500);
