import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { probeHermesAccountUsage } from "../src/probe.mjs";

const USAGE_FIXTURE = JSON.parse(
  await readFile(new URL("../testdata/wham-usage.json", import.meta.url), "utf8")
);

function fakeJwt(expSeconds) {
  const payload = Buffer.from(
    JSON.stringify({ exp: expSeconds }),
    "utf8"
  ).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function injectableEnv(overrides = {}) {
  return {
    OS: "Windows_NT",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    ...overrides
  };
}

function fakeFetch(handler) {
  const calls = [];
  return { fetch: handler, calls };
}

function awaitStream(bodyText) {
  return new Response(bodyText, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("reads Codex CLI tokens and maps wham usage into an available payload", async () => {
  const env = injectableEnv();
  const fetchCalls = [];
  const readFileImpl = async (filePath) => {
    if (filePath.endsWith(".codex\\auth.json") || filePath.endsWith(".codex/auth.json")) {
      return JSON.stringify({
        tokens: {
          access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: "rt-1",
          account_id: "acc-123"
        }
      });
    }
    return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
  };
  const result = await probeHermesAccountUsage({
    env,
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    now: () => 1_770_000_000_000,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return awaitStream(JSON.stringify(USAGE_FIXTURE));
    }
  });
  assert.equal(result.outcome, "available");
  assert.equal(result.billingMode, "subscription");
  assert.equal(result.schemaVersion, "tutti.agent.account-usage.v1");
  assert.deepEqual(
    result.quotas.map((q) => [q.quotaType, q.percentRemaining]),
    [
      ["session", 100],
      ["weekly", 100]
    ]
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(fetchCalls[0].options.headers["Authorization"], "Bearer " + String(fetchCalls[0].options.headers["Authorization"]).slice(7));
  assert.equal(fetchCalls[0].options.headers["User-Agent"], "codex-cli");
  assert.equal(fetchCalls[0].options.headers["ChatGPT-Account-Id"], "acc-123");
});

test("reports auth_required when no credential store exists", async () => {
  const readFileImpl = async () =>
    Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
  const result = await probeHermesAccountUsage({
    env: injectableEnv(),
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    fetch: async () => {
      throw new Error("must not fetch");
    }
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "auth_required");
});

test("maps 401 to session_expired", async () => {
  const readFileImpl = async () =>
    JSON.stringify({
      tokens: {
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-1"
      }
    });
  const result = await probeHermesAccountUsage({
    env: injectableEnv(),
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    fetch: async () => new Response("", { status: 401 })
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "session_expired");
});

test("maps abort to timeout", async () => {
  const readFileImpl = async () =>
    JSON.stringify({
      tokens: {
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-1"
      }
    });
  const result = await probeHermesAccountUsage({
    env: injectableEnv(),
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    fetch: async (_url, options) => {
      options.signal?.addEventListener("abort", () => {});
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "timeout");
});

test("rejects a payload without rate limit data as parse_failed", async () => {
  const readFileImpl = async () =>
    JSON.stringify({
      tokens: {
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "rt-1"
      }
    });
  const result = await probeHermesAccountUsage({
    env: injectableEnv(),
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    fetch: async () => awaitStream(JSON.stringify({ plan_type: "prolite" }))
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "parse_failed");
});

test("refreshes an expiring access token in memory before fetching", async () => {
  const env = injectableEnv();
  const readFileImpl = async () =>
    JSON.stringify({
      tokens: {
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 90),
        refresh_token: "rt-1"
      }
    });
  const refreshCalls = [];
  const result = await probeHermesAccountUsage({
    env,
    homeDirectory: () => "C:\\Users\\test",
    readFile: readFileImpl,
    fetch: async (url, options) => {
      if (url === "https://auth.openai.com/oauth/token") {
        refreshCalls.push(options);
        return awaitStream(
          JSON.stringify({
            access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: "rt-2"
          })
        );
      }
      assert.equal(options.headers["Authorization"], "Bearer " + fakeJwt(Math.floor(Date.now() / 1000) + 3600));
      return awaitStream(JSON.stringify(USAGE_FIXTURE));
    }
  });
  assert.equal(result.outcome, "available");
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].body.get("grant_type"), "refresh_token");
  assert.equal(refreshCalls[0].body.get("refresh_token"), "rt-1");
  assert.equal(refreshCalls[0].body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
});
