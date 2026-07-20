import path from "node:path";

import semver from "semver";

import { readJSON, writeJSON } from "./format.mjs";
import { validateVersions } from "./versions.mjs";

export const catalogSchemaVersion = "tutti.agent.catalog.v1";

export async function buildCatalog(options) {
  const outputPath = path.resolve(options.output || "dist/tutti-agent-extension-release/catalog.json");
  const agents = new Map();
  if (options.existingCatalog) {
    const existing = validateCatalog(await readJSON(path.resolve(options.existingCatalog)));
    for (const agent of existing.agents) agents.set(agent.agentKey, agent);
  }
  for (const file of options.versionsFile ?? []) {
    const versions = validateVersions(await readJSON(path.resolve(file)));
    agents.set(versions.agentKey, {
      agentKey: versions.agentKey,
      versionsUrl: versions.versions[0]?.release.artifactUrl.replace(
        /\/[^/]+\/[^/]+\.zip$/u,
        "/versions.json"
      ),
      versions: versions.versions.map((record) => ({
        version: record.version,
        minTuttiVersion: record.minTuttiVersion,
        requiredHostCapabilities: record.requiredHostCapabilities,
        status: record.status
      }))
    });
  }
  const catalog = {
    schemaVersion: catalogSchemaVersion,
    agents: [...agents.values()].sort((left, right) => left.agentKey.localeCompare(right.agentKey))
  };
  validateCatalog(catalog);
  await writeJSON(outputPath, catalog);
  return { outputPath, catalog };
}

export function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== catalogSchemaVersion || !Array.isArray(catalog.agents)) {
    throw new Error(`catalog must use ${catalogSchemaVersion} and contain agents`);
  }
  const seen = new Set();
  for (const agent of catalog.agents) {
    if (seen.has(agent.agentKey)) throw new Error(`duplicate catalog agent ${agent.agentKey}`);
    seen.add(agent.agentKey);
    const url = new URL(agent.versionsUrl);
    if (url.protocol !== "https:") throw new Error("catalog versionsUrl must use HTTPS");
    if (!Array.isArray(agent.versions)) throw new Error("catalog agent versions must be an array");
    for (const version of agent.versions) {
      if (!semver.valid(version.version) || !semver.valid(version.minTuttiVersion)) {
        throw new Error("catalog versions must use SemVer");
      }
    }
  }
  return catalog;
}
