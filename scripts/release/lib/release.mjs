import { cp, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createReproducibleZip } from "./archive.mjs";
import {
  fileDigestAndSize,
  normalizeBaseURL,
  requireSafeSegment,
  requireSemver,
  requireString,
  signRelease,
  writeJSON
} from "./format.mjs";
import { validateManifest, validatePackage } from "./manifest.mjs";

export const releaseSchemaVersion = "tutti.agent.release.v1";

export async function buildRelease(options) {
  const agentKey = requireSafeSegment(options.agentKey, "agent key");
  const packageDir = path.resolve(requireString(options.packageDir, "package directory"));
  const outputDir = path.resolve(options.outputDir || "dist/tutti-agent-extension-release");
  const baseURL = normalizeBaseURL(options.baseUrl);
  const sourceManifest = await validatePackage(packageDir, agentKey);
  const version = requireSemver(options.version || sourceManifest.version, "release version");
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "tutti-agent-extension-release-"));
  const stagedPackageDir = path.join(stagingRoot, "package");
  const manifest = structuredClone(sourceManifest);
  manifest.version = version;
  validateManifest(manifest, agentKey);

  const releaseDir = path.join(outputDir, "agents", agentKey, version);
  await mkdir(releaseDir, { recursive: true });
  const artifactName = `${agentKey}-${version}.zip`;
  const artifactPath = path.join(releaseDir, artifactName);
  try {
    await cp(packageDir, stagedPackageDir, { recursive: true, errorOnExist: true });
    await writeFile(
      path.join(stagedPackageDir, "tutti.agent.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    await validatePackage(stagedPackageDir, agentKey);
    await createReproducibleZip(stagedPackageDir, artifactPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  const artifact = await fileDigestAndSize(artifactPath);
  const privateKey = options.privateKey || (await readPrivateKey(options.privateKeyFile));
  const release = signRelease(
    {
      schemaVersion: releaseSchemaVersion,
      agentKey,
      version,
      manifest,
      artifactUrl: `${baseURL}/agents/${encodeURIComponent(agentKey)}/${encodeURIComponent(version)}/${encodeURIComponent(artifactName)}`,
      artifactSha256: artifact.sha256,
      artifactSizeBytes: artifact.size,
      publishedAt: options.publishedAt || new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      gitSha: String(options.gitSha ?? "").trim()
    },
    options.signingKeyId,
    privateKey
  );
  validateRelease(release);
  const releaseJsonPath = path.join(releaseDir, "release.json");
  const latestJsonPath = path.join(outputDir, "agents", agentKey, "latest.json");
  await writeJSON(releaseJsonPath, release);
  await writeJSON(latestJsonPath, release);
  return { artifactPath, releaseJsonPath, latestJsonPath, release };
}

export function validateRelease(release) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("release must be an object");
  }
  if (release.schemaVersion !== releaseSchemaVersion) {
    throw new Error(`release schemaVersion must be ${releaseSchemaVersion}`);
  }
  requireSafeSegment(release.agentKey, "release agentKey");
  requireSemver(release.version, "release version");
  validateManifest(release.manifest, release.agentKey);
  if (release.manifest.version !== release.version) {
    throw new Error("release manifest version must match release version");
  }
  const artifactURL = new URL(requireString(release.artifactUrl, "release artifactUrl"));
  if (artifactURL.protocol !== "https:") {
    throw new Error("release artifactUrl must use HTTPS");
  }
  if (!/^[a-f0-9]{64}$/iu.test(release.artifactSha256)) {
    throw new Error("release artifactSha256 must be a SHA-256 hex digest");
  }
  if (!Number.isSafeInteger(release.artifactSizeBytes) || release.artifactSizeBytes <= 0) {
    throw new Error("release artifactSizeBytes must be a positive integer");
  }
  if (release.signature?.algorithm !== "ed25519") {
    throw new Error("release signature must use ed25519");
  }
  requireString(release.signature.keyId, "release signature keyId");
  requireString(release.signature.value, "release signature value");
  return release;
}

async function readPrivateKey(privateKeyFile) {
  if (privateKeyFile) return readFile(path.resolve(privateKeyFile), "utf8");
  const environmentKey = process.env.TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY;
  if (!environmentKey) {
    throw new Error(
      "signing private key is required through --private-key-file or TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY"
    );
  }
  return environmentKey.replace(/\\n/gu, "\n");
}
