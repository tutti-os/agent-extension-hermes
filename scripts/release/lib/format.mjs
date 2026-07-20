import { createHash, sign, verify } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import semver from "semver";

export function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export function requireSemver(value, label) {
  const normalized = requireString(value, label);
  if (!semver.valid(normalized)) {
    throw new Error(`${label} must be valid SemVer, got ${normalized}`);
  }
  return normalized;
}

export function requireSafeSegment(value, label) {
  const normalized = requireString(value, label);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(normalized)) {
    throw new Error(`${label} must be a safe lowercase path segment`);
  }
  return normalized;
}

export function isRelativePackagePath(value) {
  const normalized = String(value ?? "").trim();
  return (
    normalized !== "" &&
    !path.isAbsolute(normalized) &&
    !normalized.startsWith("\\") &&
    !normalized.includes("\0") &&
    !normalized.split(/[\\/]+/u).includes("..")
  );
}

export function stableJSONStringify(value) {
  return JSON.stringify(sortJSON(value));
}

function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJSON(value[key])])
  );
}

export function releaseSigningPayload(release) {
  const { signature: _signature, ...unsigned } = release;
  return Buffer.from(stableJSONStringify(unsigned), "utf8");
}

export function signRelease(release, keyId, privateKey) {
  return {
    ...release,
    signature: {
      algorithm: "ed25519",
      keyId: requireString(keyId, "signing key id"),
      value: sign(null, releaseSigningPayload(release), privateKey).toString(
        "base64"
      )
    }
  };
}

export function verifyReleaseSignature(release, publicKey, expectedKeyId) {
  if (release.signature?.algorithm !== "ed25519") {
    throw new Error("release signature algorithm must be ed25519");
  }
  if (release.signature.keyId !== expectedKeyId) {
    throw new Error(
      `release signature key id must be ${expectedKeyId}, got ${String(release.signature.keyId)}`
    );
  }
  const signature = Buffer.from(
    requireString(release.signature.value, "release signature value"),
    "base64"
  );
  if (!verify(null, releaseSigningPayload(release), publicKey, signature)) {
    throw new Error("release signature is invalid");
  }
}

export async function fileDigestAndSize(filePath) {
  const data = await readFile(filePath);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length
  };
}

export async function readJSON(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJSON(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function normalizeBaseURL(value) {
  const normalized = requireString(value, "base URL").replace(/\/+$/u, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:") {
    throw new Error("base URL must use HTTPS");
  }
  return normalized;
}

export function parseCLIArgs(argv, repeatable = new Set()) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}`);
    }
    const key = argument
      .slice(2)
      .replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    if (repeatable.has(key)) {
      (result[key] ??= []).push(value);
    } else {
      result[key] = value;
    }
    index += 1;
  }
  return result;
}
