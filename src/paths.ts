import { homedir } from "node:os";
import { join } from "node:path";

/** Resolves the opencode data home: $OPENCODE_DATA_HOME if set, else ~/.local/share/opencode. */
export function dataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_DATA_HOME;
  if (typeof override === "string" && override.trim() !== "") return override;
  return join(homedir(), ".local", "share", "opencode");
}

/** <data-home>/usage-report */
export function pluginStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), "usage-report");
}

/** <data-home>/opencode.db */
export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataHome(env), "opencode.db");
}
