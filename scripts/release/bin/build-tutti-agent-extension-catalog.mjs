#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseCLIArgs } from "../lib/format.mjs";
import { buildCatalog } from "../lib/catalog.mjs";

export async function main() {
  const result = await buildCatalog(
    parseCLIArgs(process.argv.slice(2), new Set(["versionsFile"]))
  );
  process.stdout.write(`${JSON.stringify(result.catalog, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
