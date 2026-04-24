import { describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishProject } from "./github";

describe("github publishing", () => {
  test("passes descriptions to gh without shell substitution", () => {
    const root = mkdtempSync(join(tmpdir(), "project-github-shell-"));
    const binDir = join(root, "bin");
    const argsLog = join(root, "gh-args.log");
    const sentinel = join(root, "shell-substitution-ran");
    mkdirSync(binDir);

    const fakeGh = join(binDir, "gh");
    writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$GH_ARGS_LOG\"\n");
    chmodSync(fakeGh, 0o755);

    const originalPath = process.env.PATH;
    const originalArgsLog = process.env.GH_ARGS_LOG;
    process.env.PATH = binDir;
    process.env.GH_ARGS_LOG = argsLog;

    try {
      const description = `literal $(touch ${sentinel}) text`;
      const result = publishProject("safe-repo", root, { org: "hasna", private: true, description });

      expect(result.url).toBe("https://github.com/hasna/safe-repo");
      expect(existsSync(sentinel)).toBe(false);
      expect(readFileSync(argsLog, "utf-8")).toContain(description);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;

      if (originalArgsLog === undefined) delete process.env.GH_ARGS_LOG;
      else process.env.GH_ARGS_LOG = originalArgsLog;
    }
  });
});
