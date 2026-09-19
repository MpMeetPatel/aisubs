import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultAiSubsDataDir(): string {
  const override = process.env.AISUBS_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".aisubs");
}
