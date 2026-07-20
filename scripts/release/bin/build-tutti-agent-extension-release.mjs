#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { parseCLIArgs } from "../lib/format.mjs";
import { buildRelease } from "../lib/release.mjs";

export async function main() {
  const options = parseCLIArgs(process.argv.slice(2));
  options.gitSha ||= execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await buildRelease(options);
  process.stdout.write(`${JSON.stringify(result.release, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
