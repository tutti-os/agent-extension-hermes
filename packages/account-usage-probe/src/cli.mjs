#!/usr/bin/env node
import { probeHermesAccountUsage } from "./probe.mjs";

function executionFailedResult() {
  return {
    schemaVersion: "tutti.agent.account-usage.v1",
    outcome: "error",
    capturedAtUnixMs: Date.now(),
    errorCode: "execution_failed"
  };
}

async function main() {
  const args = process.argv.slice(2);
  const supported =
    args.length === 0 ||
    (args.length === 2 && args[0] === "--output" && args[1] === "json");
  const result = supported
    ? await probeHermesAccountUsage()
    : executionFailedResult();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(executionFailedResult())}\n`);
});
