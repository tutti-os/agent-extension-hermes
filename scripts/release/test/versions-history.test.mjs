import assert from "node:assert/strict";
import test from "node:test";

import { buildVersions, validateVersions } from "../lib/versions.mjs";

test("preserves historical manifest v1 releases while indexing v2", () => {
  const release = {
    schemaVersion: "tutti.agent.release.v1",
    agentKey: "example",
    version: "1.0.0",
    manifest: {
      schemaVersion: "tutti.agent.manifest.v1",
      agentKey: "example",
      version: "1.0.0"
    },
    artifactUrl: "https://example.test/agents/example/1.0.0/example-1.0.0.zip",
    artifactSha256: "a".repeat(64),
    artifactSizeBytes: 1,
    signature: {
      algorithm: "ed25519",
      keyId: "example-v1",
      value: "signed"
    }
  };

  assert.equal(
    validateVersions({
      schemaVersion: "tutti.agent.versions.v1",
      agentKey: "example",
      versions: [
        {
          version: "1.0.0",
          minTuttiVersion: "0.0.0",
          requiredHostCapabilities: [],
          status: "active",
          release
        }
      ]
    }).versions[0].release,
    release
  );
});

test("withdraws requested historical versions without retaining release payloads", async (t) => {
  const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "versions-withdraw-"));
  const manifest = JSON.parse(await readFile("extension/tutti.agent.json", "utf8"));
  const release = {
    schemaVersion: "tutti.agent.release.v1",
    agentKey: manifest.agentKey,
    version: manifest.version,
    manifest,
    artifactUrl: `https://example.test/agents/${manifest.agentKey}/${manifest.version}/${manifest.agentKey}-${manifest.version}.zip`,
    artifactSha256: "b".repeat(64),
    artifactSizeBytes: 1,
    publishedAt: "2026-01-01T00:00:00Z",
    gitSha: "abc123",
    signature: {
      algorithm: "ed25519",
      keyId: "example-v1",
      value: "signed"
    }
  };
  const historicalRelease = {
    ...release,
    version: "1.0.0",
    manifest: {
      schemaVersion: "tutti.agent.manifest.v1",
      agentKey: manifest.agentKey,
      version: "1.0.0",
      sidebarIcon: { src: "assets/sidebar.svg", mimeType: "image/svg+xml" }
    },
    artifactUrl: `https://example.test/agents/${manifest.agentKey}/1.0.0/${manifest.agentKey}-1.0.0.zip`
  };
  const existing = {
    schemaVersion: "tutti.agent.versions.v1",
    agentKey: manifest.agentKey,
    versions: [
      {
        version: "1.0.0",
        minTuttiVersion: "0.0.0",
        requiredHostCapabilities: [],
        status: "active",
        release: historicalRelease
      }
    ]
  };
  const releaseFile = join(root, "release.json");
  const existingFile = join(root, "existing.json");
  const output = join(root, "versions.json");
  await writeFile(releaseFile, `${JSON.stringify(release)}\n`);
  await writeFile(existingFile, `${JSON.stringify(existing)}\n`);

  await buildVersions({
    existingVersions: existingFile,
    minTuttiVersion: "0.0.0",
    output,
    releaseFile,
    withdrawVersions: "1.0.0"
  });

  const versions = JSON.parse(await readFile(output, "utf8"));
  assert.equal(versions.versions.find((entry) => entry.version === "1.0.0").status, "withdrawn");
  assert.equal("release" in versions.versions.find((entry) => entry.version === "1.0.0"), false);
});
