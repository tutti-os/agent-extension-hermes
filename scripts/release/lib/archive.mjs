import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createReproducibleZip(packageDir, artifactPath) {
  const stagingDir = await mkdtemp(path.join(tmpdir(), "tutti-agent-extension-"));
  const archiveRoot = path.join(stagingDir, "package");
  try {
    await cp(packageDir, archiveRoot, { recursive: true, dereference: false });
    const entries = await normalizeEntries(archiveRoot);
    await rm(artifactPath, { force: true });
    const result = spawnSync("zip", ["-X", "-q", artifactPath, "-@"], {
      cwd: archiveRoot,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      input: `${entries.join("\n")}\n`
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr || `zip exited with status ${result.status}`);
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function normalizeEntries(rootDir, relativeDir = "") {
  const fixedTimestamp = new Date("1980-01-01T00:00:00.000Z");
  const entries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true
  });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result = [];
  for (const entry of entries) {
    if (/[\n\r]/u.test(entry.name)) {
      throw new Error(`package path contains a newline: ${entry.name}`);
    }
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(rootDir, relativePath);
    await utimes(absolutePath, fixedTimestamp, fixedTimestamp);
    if (entry.isDirectory()) {
      await chmod(absolutePath, 0o755);
      result.push(`${relativePath}/`);
      result.push(...(await normalizeEntries(rootDir, relativePath)));
    } else if (entry.isFile()) {
      await chmod(absolutePath, 0o644);
      result.push(relativePath);
    } else {
      throw new Error(`unsupported package entry type: ${relativePath}`);
    }
  }
  return result;
}
