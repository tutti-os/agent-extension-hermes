import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const cli = path.resolve(import.meta.dirname, "..", "dist", "cli.cjs");

function run(args, env) {
  return JSON.parse(
    execFileSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8"
    })
  );
}

test("cli emits the contract schema", () => {
  const result = run(["--output", "json"], { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: "" });
  assert.equal(result.schemaVersion, "tutti.agent.account-usage.v1");
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "runtime_unavailable");
});

test("cli rejects unsupported argument shape", () => {
  const result = run(["--output", "xml"], {});
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "execution_failed");
});
