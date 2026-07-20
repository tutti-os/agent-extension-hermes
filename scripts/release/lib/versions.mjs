import path from "node:path";

import semver from "semver";

import { readJSON, requireSemver, writeJSON } from "./format.mjs";
import { validateRelease } from "./release.mjs";

export const versionsSchemaVersion = "tutti.agent.versions.v1";

export async function buildVersions(options) {
  const release = validateRelease(await readJSON(path.resolve(options.releaseFile)));
  const outputPath = path.resolve(
    options.output || `dist/tutti-agent-extension-release/agents/${release.agentKey}/versions.json`
  );
  let document = {
    schemaVersion: versionsSchemaVersion,
    agentKey: release.agentKey,
    versions: []
  };
  if (options.existingVersions) {
    document = validateVersions(await readJSON(path.resolve(options.existingVersions)));
    if (document.agentKey !== release.agentKey) {
      throw new Error("existing versions agentKey does not match release");
    }
  }
  const record = {
    version: release.version,
    minTuttiVersion: requireSemver(options.minTuttiVersion, "min Tutti version"),
    requiredHostCapabilities: normalizeCapabilities(options.requiredHostCapabilities),
    status: normalizeStatus(options.status || "active"),
    release
  };
  const existing = document.versions.find((entry) => entry.version === release.version);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new Error(`immutable release ${release.agentKey}@${release.version} changed`);
  }
  document.versions = document.versions
    .filter((entry) => entry.version !== release.version)
    .concat(existing ?? record)
    .map((entry) => withdrawVersionRecord(entry, options.withdrawVersions))
    .sort((left, right) => semver.rcompare(left.version, right.version));
  validateVersions(document);
  await writeJSON(outputPath, document);
  return { outputPath, versions: document };
}

export function validateVersions(document) {
  if (document?.schemaVersion !== versionsSchemaVersion) {
    throw new Error(`versions schemaVersion must be ${versionsSchemaVersion}`);
  }
  if (typeof document.agentKey !== "string" || !Array.isArray(document.versions)) {
    throw new Error("versions agentKey and versions are required");
  }
  const seen = new Set();
  for (const record of document.versions) {
    requireSemver(record.version, "versions record version");
    requireSemver(record.minTuttiVersion, "versions record minTuttiVersion");
    normalizeCapabilities(record.requiredHostCapabilities);
    normalizeStatus(record.status);
    if (record.status === "withdrawn" && record.release == null) {
      if (seen.has(record.version)) throw new Error(`duplicate version ${record.version}`);
      seen.add(record.version);
      continue;
    }
    validateIndexedRelease(record.release);
    if (record.release.agentKey !== document.agentKey || record.release.version !== record.version) {
      throw new Error("versions record identity must match its release");
    }
    if (seen.has(record.version)) throw new Error(`duplicate version ${record.version}`);
    seen.add(record.version);
  }
  return document;
}

function validateIndexedRelease(release) {
  if (release?.manifest?.schemaVersion !== "tutti.agent.manifest.v1") {
    return validateRelease(release);
  }
  if (release.schemaVersion !== "tutti.agent.release.v1") {
    throw new Error("historical release schemaVersion must be tutti.agent.release.v1");
  }
  if (typeof release.agentKey !== "string") {
    throw new Error("historical release agentKey is required");
  }
  requireSemver(release.version, "historical release version");
  if (
    release.manifest.agentKey !== release.agentKey ||
    release.manifest.version !== release.version
  ) {
    throw new Error("historical release manifest identity must match release");
  }
  const artifactURL = new URL(String(release.artifactUrl ?? ""));
  if (artifactURL.protocol !== "https:") {
    throw new Error("historical release artifactUrl must use HTTPS");
  }
  if (!/^[a-f0-9]{64}$/iu.test(release.artifactSha256)) {
    throw new Error("historical release artifactSha256 must be a SHA-256 hex digest");
  }
  if (!Number.isSafeInteger(release.artifactSizeBytes) || release.artifactSizeBytes <= 0) {
    throw new Error("historical release artifactSizeBytes must be positive");
  }
  if (
    release.signature?.algorithm !== "ed25519" ||
    typeof release.signature.keyId !== "string" ||
    typeof release.signature.value !== "string"
  ) {
    throw new Error("historical release signature is invalid");
  }
  return release;
}

function normalizeCapabilities(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const normalized = [...new Set(values)].sort();
  for (const capability of normalized) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(capability)) {
      throw new Error(`invalid required host capability ${capability}`);
    }
  }
  return normalized;
}

function normalizeStatus(value) {
  if (value !== "active" && value !== "withdrawn") {
    throw new Error("status must be active or withdrawn");
  }
  return value;
}

function withdrawVersionRecord(record, versions) {
  const withdrawn = normalizeWithdrawVersions(versions);
  if (!withdrawn.has(record.version)) return record;
  const { release: _release, ...withdrawnRecord } = record;
  return { ...withdrawnRecord, status: "withdrawn" };
}

function normalizeWithdrawVersions(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  return new Set(values.map((version) => requireSemver(version, "withdraw version")));
}
