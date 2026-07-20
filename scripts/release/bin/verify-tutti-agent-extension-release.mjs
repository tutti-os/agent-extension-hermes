#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { parseCLIArgs } from "../lib/format.mjs";
import { verifyRelease } from "../lib/verify.mjs";

export async function main() {
  const result = await verifyRelease(parseCLIArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ checkedArtifact: result.checkedArtifact })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
