#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseCLIArgs } from "../lib/format.mjs";
import { buildVersions } from "../lib/versions.mjs";

export async function main() {
  const result = await buildVersions(parseCLIArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.versions, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
