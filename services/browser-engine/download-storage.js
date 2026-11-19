import { randomUUID } from "node:crypto";
import { mkdir, statfs, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function validateDownloadStorage({ directory, required = false, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!directory) {
    if (required) throw new Error("Required bounded download storage path is not configured.");
    return { mode: "playwright-default" };
  }
  await mkdir(directory, { recursive: true });
  const fsInfo = await statfs(directory);
  const capacityBytes = fsInfo.bsize * fsInfo.blocks;
  if (required && fsInfo.type !== 0x01021994) {
    throw new Error("Required download storage is not a Linux tmpfs volume.");
  }
  if (required && (!capacityBytes || capacityBytes > maxBytes + fsInfo.bsize)) {
    throw new Error("Download tmpfs capacity is outside the configured safety ceiling.");
  }
  const probe = join(directory, ".openfish-write-check-" + randomUUID());
  try {
    await writeFile(probe, "ok", { flag: "wx" });
  } finally {
    await unlink(probe).catch(() => {});
  }
  return { mode: required ? "required-tmpfs" : "configured", capacityBytes };
}

export async function deleteCompletedDownload(download, path) {
  // download.path() resolves only after completion; cancel() cannot remove a completed file.
  await download.delete().catch(async () => {
    await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
  });
}
