import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.js";

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const configPath = resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "config.json");
  const raw = readFileSync(configPath, "utf-8");
  cachedConfig = JSON.parse(raw) as Config;
  return cachedConfig;
}
