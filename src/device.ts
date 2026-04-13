import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "./store/db.js";

export function getDeviceId(): string {
  const dir = getDataDir();
  const path = join(dir, "device_id");

  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim();
  }

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  writeFileSync(path, id, "utf-8");
  return id;
}
