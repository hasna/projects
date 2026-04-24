import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { Project } from "../types/index.js";
import { startSyncLog, completeSyncLog } from "../db/projects.js";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export interface SyncOptions {
  direction?: "push" | "pull" | "both";
  dryRun?: boolean;
  region?: string;
  onProgress?: (msg: string) => void;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  skipped: number;
  bytes: number;
  errors: string[];
}

function s3KeyPrefix(project: Project): string {
  const prefix = project.s3_prefix ? project.s3_prefix.replace(/\/$/, "") : "projects";
  return `${prefix}/${project.id}`;
}

function md5(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

async function collectLocalFiles(rootPath: string): Promise<Map<string, { size: number; hash: string }>> {
  const files = new Map<string, { size: number; hash: string }>();

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const relPath = relative(rootPath, fullPath);
        const data = await readFile(fullPath);
        files.set(relPath, { size: stat.size, hash: md5(data) });
      }
    }
  }

  await walk(rootPath);
  return files;
}

function makeS3Client(region: string): S3Client {
  return new S3Client({ region });
}

async function listS3Objects(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<Map<string, { etag: string; size: number }>> {
  const objects = new Map<string, { etag: string; size: number }>();
  let continuationToken: string | undefined;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix + "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      const relKey = obj.Key.slice(prefix.length + 1); // strip prefix/
      objects.set(relKey, {
        etag: (obj.ETag ?? "").replace(/"/g, ""),
        size: obj.Size ?? 0,
      });
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return objects;
}

export async function cloneProject(
  project: Project,
  targetPath: string,
  options: { region?: string; onProgress?: (msg: string) => void } = {},
): Promise<SyncResult> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(targetPath, { recursive: true });

  // Pull from S3 into the target path
  const clonedProject = { ...project, path: targetPath };
  return syncProject(clonedProject, { direction: "pull", region: options.region, onProgress: options.onProgress });
}

export async function syncProject(
  project: Project,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const direction = options.direction ?? "both";
  const region = options.region ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
  const log = options.onProgress ?? (() => {});

  if (!project.s3_bucket) {
    throw new Error(`Project "${project.name}" has no s3_bucket configured. Run: projects update ${project.slug} --s3-bucket <bucket>`);
  }

  const client = makeS3Client(region);
  const bucket = project.s3_bucket;
  const keyPrefix = s3KeyPrefix(project);
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, bytes: 0, errors: [] };

  // Start sync log
  const syncLogEntry = startSyncLog(project.id, direction);

  try {
    const [localFiles, s3Files] = await Promise.all([
      collectLocalFiles(project.path),
      listS3Objects(client, bucket, keyPrefix),
    ]);

    // PUSH: local → S3
    if (direction === "push" || direction === "both") {
      for (const [relPath, { size, hash }] of localFiles) {
        const s3Key = `${keyPrefix}/${relPath}`;
        const existing = s3Files.get(relPath);

        // Skip if S3 ETag matches local MD5 (unchanged)
        if (existing && existing.etag === hash) {
          result.skipped++;
          continue;
        }

        if (options.dryRun) {
          log(`[dry-run] push: ${relPath}`);
          result.pushed++;
          continue;
        }

        try {
          const data = await readFile(join(project.path, relPath));
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: s3Key,
              Body: data,
              ContentMD5: Buffer.from(hash, "hex").toString("base64"),
            }),
          );
          log(`push: ${relPath} (${size}B)`);
          result.pushed++;
          result.bytes += size;
        } catch (err) {
          result.errors.push(`push ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // PULL: S3 → local
    if (direction === "pull" || direction === "both") {
      for (const [relPath, s3Obj] of s3Files) {
        const localFile = localFiles.get(relPath);

        // Skip if local hash matches S3 ETag
        if (localFile && localFile.hash === s3Obj.etag) {
          result.skipped++;
          continue;
        }

        if (options.dryRun) {
          log(`[dry-run] pull: ${relPath}`);
          result.pulled++;
          continue;
        }

        try {
          const s3Key = `${keyPrefix}/${relPath}`;
          const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
          const body = resp.Body;
          if (!body) continue;

          const chunks: Uint8Array[] = [];
          for await (const chunk of body as AsyncIterable<Uint8Array>) {
            chunks.push(chunk);
          }
          const data = Buffer.concat(chunks);

          const localPath = join(project.path, relPath);
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, data);
          log(`pull: ${relPath} (${data.length}B)`);
          result.pulled++;
          result.bytes += data.length;
        } catch (err) {
          result.errors.push(`pull ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    completeSyncLog(syncLogEntry.id, {
      files_synced: result.pushed + result.pulled,
      bytes: result.bytes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    completeSyncLog(syncLogEntry.id, { error: msg });
    throw err;
  }

  return result;
}
