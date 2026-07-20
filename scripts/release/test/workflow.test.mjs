import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("release workflow protects immutable and mutable objects", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8"
  );
  assert.match(workflow, /run: pnpm check/u);
  assert.doesNotMatch(workflow, /uses:\s+[^\s#]+@v\d+/u);
  assert.match(workflow, /--published-at "\$\{published_at\}"/u);
  assert.match(workflow, /--git-sha "\$\{GITHUB_SHA\}"/u);
  assert.ok(
    workflow.indexOf("- name: Configure AWS credentials") >
      workflow.indexOf("- name: Build signed immutable release"),
    "AWS credentials must not be exposed to dependency installation or checks"
  );
  assert.match(workflow, /--if-none-match '\*'/u);
  assert.match(workflow, /put_args\+=\(--if-match "\$\{etag\}"\)/u);
  assert.match(
    workflow,
    /latest_put_args\+=\(--if-match "\$\{latest_etag\}"\)/u
  );
  const invalidation = workflow.slice(
    workflow.indexOf("- name: Invalidate mutable CDN metadata")
  );
  assert.match(invalidation, /latest\.json/u);
  assert.match(invalidation, /versions\.json/u);
  assert.match(invalidation, /cloudfront wait invalidation-completed/u);
  assert.doesNotMatch(invalidation, /--paths\s+["']?\/\*/u);
  const publicVerification = workflow.slice(
    workflow.indexOf("- name: Verify public CDN release")
  );
  assert.match(publicVerification, /\/versions\.json/u);
  assert.match(publicVerification, /\/latest\.json/u);
  assert.match(publicVerification, /\/release\.json/u);
  assert.match(publicVerification, /verify-tutti-agent-extension-release\.mjs/u);
  assert.match(publicVerification, /--public-key-file/u);
  assert.match(publicVerification, /--package-dir build\/tutti-agent\/package/u);
});

test("AWS bootstrap is repository scoped and contains no credentials", async () => {
  const template = await readFile(
    path.join(
      repositoryRoot,
      "infra/aws/agent-extension-release-infrastructure.yaml"
    ),
    "utf8"
  );
  assert.match(
    template,
    /repo:\$\{GitHubOwner\}\/\$\{GitHubRepository\}:ref:refs\/heads\/main/u
  );
  assert.match(template, /tutti-agent-releases\/\*/u);
  assert.match(template, /cloudfront:CreateInvalidation/u);
  assert.match(template, /cloudfront:GetInvalidation/u);
  assert.doesNotMatch(
    template,
    /(?:AccessKeyId|SecretAccessKey|PrivateKey|BEGIN PRIVATE KEY)/iu
  );
});
