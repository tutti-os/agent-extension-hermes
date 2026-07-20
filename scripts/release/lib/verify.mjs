import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validatePackage } from "./manifest.mjs";
import { readJSON, verifyReleaseSignature } from "./format.mjs";
import { validateRelease } from "./release.mjs";

export async function verifyRelease(options) {
  const release = validateRelease(await readJSON(path.resolve(options.releaseFile)));
  const publicKey = await readFile(path.resolve(options.publicKeyFile), "utf8");
  verifyReleaseSignature(release, publicKey, options.signingKeyId);
  const digest = await digestArtifact(options.artifact || release.artifactUrl);
  if (digest.sha256 !== release.artifactSha256 || digest.size !== release.artifactSizeBytes) {
    throw new Error("release artifact digest or size does not match signed metadata");
  }
  if (options.packageDir) {
    const manifest = await validatePackage(path.resolve(options.packageDir), release.agentKey);
    if (JSON.stringify(manifest) !== JSON.stringify(release.manifest)) {
      throw new Error("package manifest does not match signed release manifest");
    }
  }
  return { release, checkedArtifact: String(options.artifact || release.artifactUrl) };
}

async function digestArtifact(value) {
  const source = String(value);
  if (/^https?:\/\//u.test(source)) {
    const response = await fetch(source);
    if (!response.ok || !response.body) {
      throw new Error(`artifact download failed with HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { sha256: hash.digest("hex"), size };
  }
  const filePath = path.resolve(source);
  const hash = createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: hash.digest("hex"), size };
}
