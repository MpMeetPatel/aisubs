import { execFileSync, spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
let firstStart = true;

function configuredPort() {
  const index = args.indexOf("--port");
  return index === -1 ? 4319 : Number(args[index + 1]);
}

function listeningPids(port) {
  if (process.platform === "win32" || !port) return [];
  try {
    return execFileSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function stopExistingDashboard() {
  const port = configuredPort();
  if (!port) return;
  const health = await fetch(`http://127.0.0.1:${port}/health`)
    .then(async (response) => ({
      body: await response.json(),
      service: response.headers.get("x-aisubs-service"),
      pid: response.headers.get("x-aisubs-pid"),
    }))
    .catch(() => null);
  if (health?.body?.ok !== true) return;

  const reportedPid = Number(health.pid);
  const verifiedPid =
    health.service === "aisubs" && Number.isSafeInteger(reportedPid) && reportedPid > 0;
  for (const pid of verifiedPid ? [reportedPid] : listeningPids(port)) {
    if (!verifiedPid) {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
      });
      if (!/dist\/cli\.js dashboard(?:\s|$)/.test(command)) continue;
    }
    console.log(`Restarting the existing AISubs dashboard on port ${port}...`);
    process.kill(pid, "SIGTERM");
    for (let attempt = 0; attempt < 30 && listeningPids(port).includes(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

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

await stopExistingDashboard();
const children = [
  spawn(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"],
    { stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--watch", "--config", "dashboard/vite.config.ts"],
    { stdio: "inherit" },
  ),
];
await new Promise((resolve) => setTimeout(resolve, 500));
let previous = (await snapshot("dist")).sort().join("\n");
let pending = previous;
let dashboard = run();
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
  if (current !== pending) {
    pending = current;
    return;
  }
  if (!current.includes("dist/cli.js:")) return;
  previous = current;
  restarting = true;
  dashboard.kill("SIGTERM");
  await new Promise((resolve) => dashboard.once("close", resolve));
  dashboard = run();
  restarting = false;
}, 500);
