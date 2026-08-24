import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  probeHermesAccountUsage,
  ACCOUNT_USAGE_SCHEMA_VERSION
} from "../src/probe.mjs";

const RUNTIME_ROOT = path.join(os.tmpdir(), "hermes-runtime-root");

test("probe fails closed when the runtime root is absent", async () => {
  const result = await probeHermesAccountUsage({
    env: {},
    platform: () => "linux"
  });
  assert.equal(result.schemaVersion, ACCOUNT_USAGE_SCHEMA_VERSION);
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "runtime_unavailable");
});

test("probe delegates to the runtime python and maps codex windows", async () => {
  const captured = [];
  const result = await probeHermesAccountUsage({
    env: { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: RUNTIME_ROOT },
    platform: () => "linux",
    now: () => 1_717_000_000_000,
    resolvePython: () => path.join(RUNTIME_ROOT, "tools", "hermes-agent", "bin", "python"),
    invokePython: async (python, snippet, env, limits) => {
      captured.push({ python, snippet, env, limits });
      return JSON.stringify({
        provider: "openai-codex",
        plan: "ProLite",
        unavailableReason: "",
        windows: [
          { label: "Session", usedPercent: 0, resetAtUnixMs: 1_717_200_000_000 },
          { label: "Weekly", usedPercent: 25, resetAtUnixMs: 1_733_400_000_000 }
        ]
      });
    }
  });
  assert.equal(result.outcome, "available");
  assert.equal(result.billingMode, "subscription");
  assert.equal(result.quotas.length, 2);
  assert.equal(result.quotas[0].quotaType, "session");
  assert.equal(result.quotas[0].percentRemaining, 100);
  assert.equal(result.quotas[0].resetsAtUnixMs, 1_717_200_000_000);
  assert.equal(result.quotas[1].quotaType, "weekly");
  assert.equal(result.quotas[1].percentRemaining, 75);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].python.endsWith(path.join("tools", "hermes-agent", "bin", "python")));
  assert.match(captured[0].snippet, /fetch_account_usage/);
  assert.equal(captured[0].env.TUTTI_AGENT_RUNTIME_INSTALL_ROOT, RUNTIME_ROOT);
});

test("probe prefers the managed runtime tool that carries the launcher", async () => {
  let invoked = "";
  await probeHermesAccountUsage({
    env: { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: RUNTIME_ROOT },
    platform: () => "linux",
    resolvePython: () => path.join(RUNTIME_ROOT, "tools", "hermes-agent", "bin", "python"),
    invokePython: async (python) => {
      invoked = python;
      return JSON.stringify({ provider: "openai-codex", plan: "ProLite", unavailableReason: "", windows: [] });
    }
  });
  assert.ok(invoked.endsWith(path.join("tools", "hermes-agent", "bin", "python")));
});

test("probe maps a hermes runtime error to a stable code", async () => {
  const result = await probeHermesAccountUsage({
    env: { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: RUNTIME_ROOT },
    platform: () => "linux",
    resolvePython: () => path.join(RUNTIME_ROOT, "tools", "hermes-agent", "bin", "python"),
    invokePython: async () =>
      JSON.stringify({ error: "AuthError: Not logged in" })
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "auth_required");
});

test("probe surfaces api billing when no windows are reported", async () => {
  const result = await probeHermesAccountUsage({
    env: { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: RUNTIME_ROOT },
    platform: () => "linux",
    resolvePython: () => path.join(RUNTIME_ROOT, "tools", "hermes-agent", "bin", "python"),
    invokePython: async () =>
      JSON.stringify({ provider: "openrouter", plan: "", unavailableReason: "", windows: [] })
  });
  assert.equal(result.outcome, "available");
  assert.equal(result.billingMode, "api");
  assert.deepEqual(result.quotas, []);
});

test("probe falls back to execution_failed for unexpected output", async () => {
  const result = await probeHermesAccountUsage({
    env: { TUTTI_AGENT_RUNTIME_INSTALL_ROOT: RUNTIME_ROOT },
    platform: () => "linux",
    resolvePython: () => path.join(RUNTIME_ROOT, "tools", "hermes-agent", "bin", "python"),
    invokePython: async () => "not-json"
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "parse_failed");
});
