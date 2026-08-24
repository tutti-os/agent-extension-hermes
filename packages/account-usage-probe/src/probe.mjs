import { readFile as readFileFromDisk } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v1";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_USER_AGENT = "hermes-cli/0.19.0";
const CODEX_REFRESH_SKEW_SECONDS = 120;
const MAX_RESPONSE_BYTES = 1 << 20;
const REQUEST_TIMEOUT_MS = 8_000;

const ERROR_CODES = new Set([
  "auth_required",
  "config_invalid",
  "execution_failed",
  "parse_failed",
  "rate_limited",
  "session_expired",
  "timeout"
]);

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class AuthorizationFailure extends ProbeFailure {
  constructor() {
    super("session_expired");
  }
}

function refreshFailureToProbeFailure(error) {
  if (error instanceof ProbeFailure) return error;
  const status = Number(error?.status ?? (error?.response ?? {}).status);
  if (status === 429) return new ProbeFailure("rate_limited");
  if (status === 401 || status === 403) return new ProbeFailure("session_expired");
  if (error?.name === "AbortError") return new ProbeFailure("timeout");
  if (error instanceof TypeError && error?.cause?.code === "ECONNREFUSED") {
    return new ProbeFailure("execution_failed");
  }
  if (error instanceof AuthorizationFailure) return error;
  return new ProbeFailure("execution_failed");
}

/**
 * Mirror of Hermes' agent/account_usage.py Codex quota path:
 * resolve runtime credentials (Hermes auth store, else Codex CLI auth.json),
 * refresh in memory when the access token is expiring, then read the Codex
 * usage endpoint. The probe is strictly read-only: no auth store mutation.
 */
export async function probeHermesAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const dependencies = {
      env: options.env ?? process.env,
      fetch: options.fetch ?? globalThis.fetch,
      homeDirectory: options.homeDirectory ?? homedir,
      readFile: options.readFile ?? readFileFromDisk
    };
    const credentials = await resolveCodexCredentials(dependencies);
    const usage = await fetchUsage(credentials, dependencies);
    const quotas = parseUsageQuotas(usage, capturedAtUnixMs);
    if (quotas.length === 0) {
      throw new ProbeFailure("parse_failed");
    }
    return {
      schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
      outcome: "available",
      capturedAtUnixMs,
      billingMode: "subscription",
      quotas
    };
  } catch (error) {
    return {
      schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
      outcome: "error",
      capturedAtUnixMs,
      errorCode: stableErrorCode(error)
    };
  }
}

async function resolveCodexCredentials(dependencies) {
  const env = dependencies.env;
  const home = resolveHermesHome(env, dependencies.homeDirectory);
  const hermesStore = await readStrongTokenStore(
    path.join(home, "auth.json"),
    dependencies.readFile,
    { env, dependencies }
  );
  if (hermesStore) return hermesStore;

  const codexHome = stringValue(env.CODEX_HOME) || path.join(dependencies.homeDirectory(), ".codex");
  const cliStore = await readStrongTokenStore(
    path.join(codexHome, "auth.json"),
    dependencies.readFile,
    { env, dependencies }
  );
  if (cliStore) return cliStore;
  throw new ProbeFailure("auth_required");
}

function resolveHermesHome(env, homeDirectory) {
  const override = stringValue(env.HERMES_HOME);
  if (override) return override;
  // Platform-native default mirrors hermes_constants: %LOCALAPPDATA%\hermes on
  // native Windows, ~/.hermes elsewhere.
  if (env.OS && /windows/i.test(env.OS) && typeof env.LOCALAPPDATA === "string") {
    return path.join(env.LOCALAPPDATA, "hermes");
  }
  return path.join(homeDirectory(), ".hermes");
}

async function readStrongTokenStore(authPath, readFile, options = {}) {
  const dependencies = options.dependencies ?? {};
  let content;
  try {
    content = await readFile(authPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ProbeFailure("execution_failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(content));
  } catch {
    throw new ProbeFailure("config_invalid");
  }
  const providerState = recordValue(recordValue(parsed?.providers)?.["openai-codex"]);
  let tokens = recordValue(providerState?.tokens);
  let accountId = stringValue(providerState?.tokens?.account_id);
  if (!tokens) {
    // Codex CLI auth.json shape: tokens at the root.
    tokens = recordValue(parsed?.tokens);
    accountId = accountId || stringValue(parsed?.tokens?.account_id);
  }
  const accessToken = stringValue(tokens?.access_token);
  const refreshToken = stringValue(tokens?.refresh_token);
  if (!accessToken) return null;
  if (accessTokenExpiring(accessToken, CODEX_REFRESH_SKEW_SECONDS) && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken, dependencies);
    tokens = { ...tokens, ...refreshed };
  } else if (accessTokenExpiring(accessToken, 0)) {
    return null;
  }
  return {
    baseUrl: baseUrlFromEnv(options.env ?? {}),
    accessToken: stringValue(tokens?.access_token),
    accountId
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function baseUrlFromEnv(env) {
  const override = stringValue(env.HERMES_CODEX_BASE_URL).replace(/\/+$/, "");
  return override || DEFAULT_CODEX_BASE_URL;
}

function accessTokenExpiring(accessToken, skewSeconds) {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  return exp * 1000 <= Date.now() + Math.max(0, skewSeconds) * 1000;
}

function decodeJwtClaims(token) {
  const part = String(token).split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const decoded = JSON.parse(json);
    return decoded !== null && typeof decoded === "object" ? decoded : null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken, dependencies = {}) {
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImplementation(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "User-Agent": CODEX_OAUTH_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID
      })
    });
  } catch (error) {
    throw refreshFailureToProbeFailure(error);
  }
  if (response.status === 429) throw new ProbeFailure("rate_limited");
  if (!response.ok) throw new ProbeFailure("session_expired");
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new ProbeFailure("parse_failed");
  }
  const accessToken = stringValue(body?.access_token);
  const newRefresh = stringValue(body?.refresh_token);
  if (!accessToken) throw new ProbeFailure("session_expired");
  return { access_token: accessToken, ...(newRefresh ? { refresh_token: newRefresh } : {}) };
}

async function fetchUsage(credentials, dependencies) {
  const fetchImplementation = dependencies.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli"
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  try {
    const response = await fetchImplementation(resolveUsageUrl(credentials.baseUrl), {
      headers,
      redirect: "error",
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationFailure();
    }
    if (response.status === 429) {
      throw new ProbeFailure("rate_limited");
    }
    if (!response.ok) {
      throw new ProbeFailure("execution_failed");
    }
    const bodyText = await readResponseTextBounded(response);
    try {
      const parsed = JSON.parse(bodyText);
      return recordValue(parsed) ?? {};
    } catch {
      throw new ProbeFailure("parse_failed");
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    if (error?.name === "AbortError") throw new ProbeFailure("timeout");
    throw new ProbeFailure("execution_failed");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Mirrors `_codex_backend_urls` / `_resolve_codex_usage_url` in Hermes
 * account_usage.py: base URLs under /backend-api use the ChatGPT
 * /wham/... paths; everything else uses /api/codex/....
 */
function resolveUsageUrl(baseUrl) {
  let base = stringValue(baseUrl).replace(/\/+$/, "");
  if (!base) base = DEFAULT_CODEX_BASE_URL;
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ProbeFailure("config_invalid");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/codex")) {
    pathname = pathname.slice(0, -"/codex".length);
  }
  const prefix = pathname.includes("/backend-api")
    ? `${url.origin}${pathname.replace(/\/$/, "")}/wham`
    : `${url.origin}${pathname.replace(/\/$/, "")}/api/codex`;
  return `${prefix}/usage`;
}

function parseUsageQuotas(payload, capturedAtUnixMs) {
  const quotas = [];
  const rateLimit = recordValue(payload.rate_limit);
  if (!rateLimit) throw new ProbeFailure("parse_failed");
  for (const [key, quotaType] of [
    ["primary_window", "session"],
    ["secondary_window", "weekly"]
  ]) {
    const window = recordValue(rateLimit[key]);
    if (!window) continue;
    const usedPercent = finiteNumber(window.used_percent);
    if (usedPercent === null) continue;
    quotas.push({
      quotaType,
      percentRemaining: clampPercent(100 - usedPercent),
      ...(resetTimeFromRow(window, capturedAtUnixMs) === null
        ? {}
        : { resetsAtUnixMs: resetTimeFromRow(window, capturedAtUnixMs) })
    });
  }
  return quotas;
}

function resetTimeFromRow(row, capturedAtUnixMs) {
  const parsed = absoluteUnixMs(row.reset_at);
  return parsed;
}

function absoluteUnixMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isSafeInteger(Math.trunc(milliseconds)) ? Math.trunc(milliseconds) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampPercent(value) {
  const rounded = Math.round(value * 100) / 100;
  return Math.max(0, Math.min(100, rounded));
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function recordValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapturedAt(value) {
  const normalized = Math.trunc(value);
  return Number.isSafeInteger(normalized) && normalized >= 0
    ? normalized
    : Date.now();
}

function stableErrorCode(error) {
  return error instanceof ProbeFailure && ERROR_CODES.has(error.code)
    ? error.code
    : "execution_failed";
}

async function readResponseTextBounded(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ProbeFailure("parse_failed");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProbeFailure("parse_failed");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}
