import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v1";

const MAX_OUTPUT_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 25_000;

const ERROR_CODES = new Set([
  "auth_required",
  "config_invalid",
  "execution_failed",
  "no_data",
  "parse_failed",
  "rate_limited",
  "runtime_unavailable",
  "session_expired",
  "timeout"
]);

const ERROR_CODE_HINTS = [
  ["rate_limited", ["429", "rate limit", "exhausted", "quota exceeded"]],
  ["auth_required", ["not logged", "no creds", "credential", "login", "auth"]],
  ["session_expired", ["expired", "unauthorized", "401", "403", "invalid token"]],
  ["timeout", ["timed out", "timeout", "connect"]],
  ["config_invalid", ["disabled in config", "is disabled", "config"]],
  ["no_data", ["no snapshot", "no usage", "unavailable"]],
  ["parse_failed", ["json", "parse"]]
];

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The probe never re-implements account-usage retrieval. It delegates to the
// Hermes runtime's own provider resolution and account-usage logic, then
// projects the result onto the Tutti account-usage contract.
const HERMES_USAGE_PROBE = String.raw`
import json
try:
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from agent.account_usage import fetch_account_usage
    runtime = resolve_runtime_provider()
    provider = str((runtime or {}).get("provider") or "").strip()
    if not provider:
        raise RuntimeError("runtime provider is unresolved")
    api_key = str((runtime or {}).get("api_key") or "").strip() or None
    base_url = str((runtime or {}).get("base_url") or "").strip() or None
    snapshot = fetch_account_usage(provider, base_url=base_url, api_key=api_key)
    if snapshot is None:
        raise RuntimeError("account usage snapshot is unavailable")
    payload = {
        "provider": snapshot.provider,
        "plan": snapshot.plan if snapshot.plan is not None else "",
        "unavailableReason": snapshot.unavailable_reason or "",
        "windows": [
            {
                "label": window.label,
                "usedPercent": window.used_percent,
                "resetAtUnixMs": round(window.reset_at.timestamp() * 1000) if window.reset_at else None,
            }
            for window in snapshot.windows
        ],
    }
    print(json.dumps(payload))
except Exception as error:
    print(json.dumps({"error": "%s: %s" % (type(error).__name__, error)}))
`;

export async function probeHermesAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const env = options.env ?? process.env;
    const runtimeRoot = String(env.TUTTI_AGENT_RUNTIME_INSTALL_ROOT ?? "").trim();
    if (!runtimeRoot) {
      throw new ProbeFailure("runtime_unavailable");
    }
    const platform = options.platform?.() ?? process.platform;
    const python = options.resolvePython
      ? options.resolvePython(runtimeRoot, platform)
      : resolveRuntimePython(runtimeRoot, platform);
    const output = await invokeRuntimePython(
      python,
      HERMES_USAGE_PROBE,
      env,
      options.invokePython ?? defaultPythonInvocation,
      options.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    const payload = parseRuntimePayload(output);
    if (payload.error) {
      throw new ProbeFailure(stableErrorCode(payload.error));
    }
    if (payload.unavailableReason) {
      throw new ProbeFailure(stableErrorCode(payload.unavailableReason));
    }
    const windows = payload.windows ?? [];
    const quotas = windows.map((window) => usageQuota(window)).filter(Boolean);
    if (quotas.length > 0) {
      return availableResult(capturedAtUnixMs, "subscription", quotas);
    }
    if (windows.length > 0) {
      // Hermes reported windows we could not project onto the contract.
      throw new ProbeFailure("no_data");
    }
    // Hermes reports data without subscription windows (API-key billing or a
    // provider account surface): the account is reachable but has no
    // projectable limits.
    return availableResult(capturedAtUnixMs, "api", []);
  } catch (error) {
    return errorResult(
      capturedAtUnixMs,
      error instanceof ProbeFailure ? error.code : "execution_failed"
    );
  }
}

function availableResult(capturedAtUnixMs, billingMode, quotas) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "available",
    capturedAtUnixMs,
    billingMode,
    quotas
  };
}

function errorResult(capturedAtUnixMs, errorCode) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "error",
    capturedAtUnixMs,
    errorCode
  };
}

function normalizeCapturedAt(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? Math.trunc(timestamp) : Date.now();
}

// Resolve the Hermes runtime tool environment so the probe can call Hermes'
// own Python code. Prefer the tool that also carries the runtime launcher and
// falls back to any managed tool environment containing a Python interpreter.
function resolveRuntimePython(runtimeRoot, platform) {
  const toolsDir = path.join(runtimeRoot, "tools");
  if (!existsSync(toolsDir)) {
    throw new ProbeFailure("runtime_unavailable");
  }
  const launcher = platform === "win32" ? "hermes.exe" : "hermes";
  const pythonSuffix = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  const candidates = [];
  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const toolDir = path.join(toolsDir, entry.name);
    const python = path.join(toolDir, ...pythonSuffix);
    if (!existsSync(python)) {
      continue;
    }
    const hasLauncher = existsSync(path.join(toolDir, "bin", launcher)) || existsSync(path.join(toolDir, "Scripts", launcher));
    candidates.push({ python, hasLauncher });
  }
  const preferred = candidates.find((candidate) => candidate.hasLauncher);
  const python = (preferred ?? candidates[0])?.python ?? "";
  if (!python) {
    throw new ProbeFailure("runtime_unavailable");
  }
  return python;
}

function invokeRuntimePython(python, snippet, env, launcher, timeoutMs) {
  return launcher(python, snippet, env, { timeoutMs, maxBuffer: MAX_OUTPUT_BYTES });
}

function defaultPythonInvocation(python, snippet, env, limits) {
  return execFileSync(python, ["-c", snippet], {
    env,
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBuffer,
    encoding: "utf8"
  });
}

function parseRuntimePayload(output) {
  const text = String(output ?? "").trim();
  const lastLine = text.split(/\r?\n/u).pop() ?? "";
  try {
    return JSON.parse(lastLine);
  } catch {
    throw new ProbeFailure("parse_failed");
  }
}

function usageQuota(window) {
  const usedPercent = Number(window?.usedPercent);
  if (!Number.isFinite(usedPercent)) {
    return null;
  }
  const resetAtUnixMs = Number(window?.resetAtUnixMs);
  const quota = {
    quotaType: quotaTypeForLabel(window?.label),
    percentRemaining: Math.max(0, Math.min(100, 100 - Math.round(usedPercent)))
  };
  if (Number.isFinite(resetAtUnixMs) && resetAtUnixMs > 0) {
    quota.resetsAtUnixMs = Math.trunc(resetAtUnixMs);
  }
  return quota;
}

function quotaTypeForLabel(label) {
  const normalized = String(label ?? "").trim().toLowerCase();
  if (normalized.includes("session")) return "session";
  if (normalized.includes("daily")) return "daily";
  if (normalized.includes("weekly")) return "weekly";
  if (normalized.includes("monthly")) return "monthly";
  return "session";
}

function stableErrorCode(message) {
  const lower = String(message ?? "").toLowerCase();
  for (const [code, hints] of ERROR_CODE_HINTS) {
    if (hints.some((hint) => lower.includes(hint))) {
      return code;
    }
  }
  return "execution_failed";
}
