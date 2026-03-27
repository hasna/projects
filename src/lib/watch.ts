import { createHash } from "node:crypto";
import { readFileSync, statSync, watch as fsWatch } from "node:fs";
import { relative, join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Project } from "../types/index.js";

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEBOUNCE_MS = 2000;

export async function watchProject(
  project: Project,
  options: { region?: string; onEvent?: (msg: string) => void } = {},
): Promise<void> {
  if (!project.s3_bucket) throw new Error(`Project "${project.name}" has no s3_bucket configured.`);

  const log = options.onEvent ?? ((m: string) => console.log(m));
  const region = options.region ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
  const client = new S3Client({ region });
  const bucket = project.s3_bucket;
  const keyPrefix = `${project.s3_prefix ? project.s3_prefix.replace(/\/$/, "") : "projects"}/${project.id}`;

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const hashes = new Map<string, string>();

  log(`Watching ${project.path} → s3://${bucket}/${keyPrefix}/`);
  log("Press Ctrl+C to stop.\n");

  await new Promise<void>((resolve, reject) => {
    const watcher = fsWatch(project.path, { recursive: true }, (_event, filename) => {
      if (!filename || typeof filename !== "string") return;
      const fullPath = join(project.path, filename);

      if (pending.has(filename)) clearTimeout(pending.get(filename)!);
      pending.set(filename, setTimeout(async () => {
        pending.delete(filename);
        try {
          const stat = statSync(fullPath);
          if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return;
          const data = readFileSync(fullPath);
          const hash = createHash("md5").update(data).digest("hex");
          if (hashes.get(filename) === hash) return;
          hashes.set(filename, hash);
          const relPath = relative(project.path, fullPath);
          await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${keyPrefix}/${relPath}`, Body: data }));
          log(`↑ pushed: ${relPath} (${stat.size}B)`);
        } catch { /* deleted or unreadable */ }
      }, DEBOUNCE_MS));
    });

    process.once("SIGINT", () => { watcher.close(); resolve(); });
    watcher.once("error", reject);
  });
}
