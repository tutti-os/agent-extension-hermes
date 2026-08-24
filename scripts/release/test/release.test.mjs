import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { buildRelease } from "../lib/release.mjs";
import { validatePackage } from "../lib/manifest.mjs";
import { verifyRelease } from "../lib/verify.mjs";
import { resolvePythonCommand } from "../../python-command.mjs";

const temporaryRoots = new Set();
const pythonCommand = resolvePythonCommand();

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-extension-release-test-")
  );
  temporaryRoots.add(root);
  return root;
}

test("builds a reproducible signed extension release", async () => {
  const root = await temporaryRoot();
  const packageDir = await writeFixture(path.join(root, "package"));
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPath = path.join(root, "public.pem");
  await writeFile(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const options = {
    agentKey: "hermes",
    packageDir,
    outputDir: path.join(root, "out"),
    baseUrl: "https://example.test/tutti-agent-releases",
    version: "1.0.0",
    signingKeyId: "tutti-hermes-release-v1",
    privateKey,
    publishedAt: "2026-07-14T00:00:00Z",
    gitSha: "abc123"
  };
  const sourceManifest = await readFile(
    path.join(packageDir, "tutti.agent.json")
  );
  const first = await buildRelease(options);
  const firstArtifact = await readFile(first.artifactPath);
  await chmod(path.join(packageDir, "locales", "en.json"), 0o600);
  const second = await buildRelease(options);
  assert.deepEqual(await readFile(second.artifactPath), firstArtifact);
  assert.deepEqual(
    await readFile(path.join(packageDir, "tutti.agent.json")),
    sourceManifest
  );
  await verifyRelease({
    releaseFile: second.releaseJsonPath,
    artifact: second.artifactPath,
    publicKeyFile: publicKeyPath,
    signingKeyId: "tutti-hermes-release-v1",
    packageDir
  });
});

test("signs and verifies the actual packaged Hermes extension", async () => {
  const root = await temporaryRoot();
  const packageDir = path.resolve(
    import.meta.dirname,
    "../../../build/tutti-agent/package"
  );
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPath = path.join(root, "public.pem");
  await writeFile(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const result = await buildRelease({
    agentKey: "hermes",
    packageDir,
    outputDir: path.join(root, "out"),
    baseUrl: "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases",
    version: "1.0.10",
    signingKeyId: "tutti-hermes-release-v1",
    privateKey: keys.privateKey,
    publishedAt: "2026-07-17T00:00:00Z",
    gitSha: "verification"
  });
  assert.equal(result.release.manifest.agentKey, "hermes");
  assert.deepEqual(result.release.manifest.runtime.launch.args, ["acp"]);
  await verifyRelease({
    releaseFile: result.releaseJsonPath,
    artifact: result.artifactPath,
    publicKeyFile: publicKeyPath,
    signingKeyId: "tutti-hermes-release-v1",
    packageDir
  });
});

test("rejects executable package content", async () => {
  const root = await temporaryRoot();
  const packageDir = await writeFixture(path.join(root, "package"));
  const executable = path.join(packageDir, "profiles", "install.json");
  await writeFile(executable, "{}\n");
  await chmod(executable, 0o755);
  await assert.rejects(
    buildRelease({
      agentKey: "hermes",
      packageDir,
      outputDir: path.join(root, "out"),
      baseUrl: "https://example.test/releases",
      signingKeyId: "tutti-hermes-release-v1",
      privateKey: generateKeyPairSync("ed25519").privateKey
    }),
    /executable file/u
  );
});

test("rejects symlinks", async () => {
  const packageDir = await temporaryFixture();
  await symlink("en.json", path.join(packageDir, "locales", "alias.json"));
  await assert.rejects(validatePackage(packageDir, "hermes"), /symlinks/u);
});

test("rejects unsafe referenced paths", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.icon.src = "../icon.svg";
  });
  await assert.rejects(validatePackage(packageDir, "hermes"), /relative package path/u);
});

test("rejects managed executables that escape installRoot", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.launch.executable = "${installRoot}/../outside/hermes";
  });
  await assert.rejects(validatePackage(packageDir, "hermes"), /stay under/u);
});

test("accepts a private managed runtime command", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.launch.publishUserCommand = false;
  });
  await validatePackage(packageDir, "hermes");
});

test("rejects a non-boolean managed runtime publication policy", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.launch.publishUserCommand = "false";
  });
  await assert.rejects(validatePackage(packageDir, "hermes"), /must be a boolean/u);
});

test("rejects unsupported manifest fields in both validators", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.shell = true;
  });
  await assert.rejects(validatePackage(packageDir, "hermes"), /unsupported fields/u);

  const repositoryPackage = path.join(path.dirname(packageDir), "repository-package");
  await cp(
    path.resolve(import.meta.dirname, "../../../extension"),
    repositoryPackage,
    { recursive: true }
  );
  await mutateManifest(repositoryPackage, (manifest) => {
    manifest.runtime.shell = true;
  });
  const python = spawnSync(
    pythonCommand.executable,
    [...pythonCommand.args,
      path.resolve(import.meta.dirname, "../../validate_agent_extension.py"),
      repositoryPackage
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(python.status, 0);
  assert.match(python.stderr, /unsupported fields/u);
});

test("rejects unsupported profile fields in both validators", async () => {
  const root = await temporaryRoot();
  const packageDir = path.join(root, "repository-package");
  await cp(
    path.resolve(import.meta.dirname, "../../../extension"),
    packageDir,
    { recursive: true }
  );
  const composerPath = path.join(packageDir, "profiles", "composer.json");
  const composer = JSON.parse(await readFile(composerPath, "utf8"));
  composer.provider = "hermes";
  await writeFile(composerPath, `${JSON.stringify(composer, null, 2)}\n`);

  await assert.rejects(validatePackage(packageDir, "hermes"), /unsupported fields/u);
  const python = spawnSync(
    pythonCommand.executable,
    [...pythonCommand.args,
      path.resolve(import.meta.dirname, "../../validate_agent_extension.py"),
      packageDir
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(python.status, 0);
  assert.match(python.stderr, /unsupported fields/u);
});

test("both validators enforce capability names and boolean values", async () => {
  const packageDir = await repositoryFixture();
  const capabilitiesPath = path.join(packageDir, "profiles", "capabilities.json");
  const capabilities = JSON.parse(await readFile(capabilitiesPath, "utf8"));
  capabilities.declared.shell = true;
  await writeFile(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`);
  await assertBothValidatorsReject(packageDir, /unsupported fields/u);

  delete capabilities.declared.shell;
  capabilities.declared.skills = "yes";
  await writeFile(capabilitiesPath, `${JSON.stringify(capabilities, null, 2)}\n`);
  await assertBothValidatorsReject(packageDir, /values must be booleans/u);
});

test("both validators enforce discovery and safe Skill roots", async () => {
  const packageDir = await repositoryFixture();
  const discoveryPath = path.join(packageDir, "profiles", "discovery.json");
  const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  discovery.candidates[0].probe.timeoutMs = 0;
  await writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`);
  await assertBothValidatorsReject(packageDir, /timeoutMs must be/u);

  const composerPath = path.join(packageDir, "profiles", "composer.json");
  const composer = JSON.parse(await readFile(composerPath, "utf8"));
  composer.skills ??= { invocation: "textTrigger", triggerPrefix: "/", roots: [{ scope: "workspace", path: ".agent/skills" }] };
  composer.skills.roots[0].path = "../skills";
  await writeFile(composerPath, `${JSON.stringify(composer, null, 2)}\n`);
  discovery.candidates[0].probe.timeoutMs = 5000;
  await writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`);
  await assertBothValidatorsReject(packageDir, /safe relative POSIX path/u);
});

test("rejects files not declared by the manifest", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(path.join(packageDir, "profiles", "undeclared.json"), "{}\n");
  await assert.rejects(validatePackage(packageDir, "hermes"), /not declared/u);
});

test("rejects unpinned runtime packages", async () => {
  const packageDir = await temporaryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.runtime.install.args[2] = "hermes-agent[acp]";
  });
  await assert.rejects(validatePackage(packageDir, "hermes"), /exact package==version/u);
});

test("rejects oversized presentation assets", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(
    path.join(packageDir, "assets", "hero-image.jpg"),
    Buffer.alloc(256 * 1024 + 1)
  );
  await assert.rejects(validatePackage(packageDir, "hermes"), /exceeds 256 KiB/u);
});

test("both validators reject non-image presentation assets", async () => {
  const packageDir = await repositoryFixture();
  await mutateManifest(packageDir, (manifest) => {
    manifest.icon.src = "locales/en.json";
  });
  await assertBothValidatorsReject(packageDir, /supported image file type/u);
});

test("rejects active or remotely loaded SVG assets", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n'
  );
  await assert.rejects(validatePackage(packageDir, "hermes"), /active or remote/u);
});

test("rejects SVG assets with remote references", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="//example.test/a.png"/></svg>\n'
  );
  await assert.rejects(validatePackage(packageDir, "hermes"), /active or remote/u);
});

test("rejects non-HTTP and CSS SVG references", async () => {
  const packageDir = await temporaryFixture();
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="/remote.png"/></svg>\n'
  );
  await assert.rejects(validatePackage(packageDir, "hermes"), /active or remote/u);
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "ftp://example.test/a.css";</style></svg>\n'
  );
  await assert.rejects(validatePackage(packageDir, "hermes"), /active or remote/u);
});

test("both validators reject active and non-local SVG forms", async () => {
  const packageDir = await repositoryFixture();
  const iconPath = path.join(packageDir, "assets", "icon.svg");
  await mutateManifest(packageDir, (manifest) => { manifest.icon.src = "assets/icon.svg"; });
  await rm(path.join(packageDir, "assets", "icon.png"));
  const unsafeSVGs = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n',
    '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>\n',
    '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:foreignObject/></svg:svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="//example.test/a.png"/></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="/remote.png"/></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "ftp://example.test/a.css";</style></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.test/a.svg#x)}</style></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@\\69mport "https://example.test/a.css";</style></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:\\75rl(https://example.test/a.svg#x)"/></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.test/a.svg"><use href="#x"/></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#x72;l(https://example.test/a.svg#x)"/></svg>\n',
    '<svg xmlns="http://www.w3.org/2000/svg"><image id="x"/><set href="#x" attributeName="href" to="https://example.test/a.png"/></svg>\n'
  ];
  for (const source of unsafeSVGs) {
    await writeFile(iconPath, source);
    await assertBothValidatorsReject(packageDir, /active or remote/u);
  }
});

async function repositoryFixture() {
  const root = await temporaryRoot();
  const packageDir = path.join(root, "repository-package");
  await cp(
    path.resolve(import.meta.dirname, "../../../extension"),
    packageDir,
    { recursive: true }
  );
  return packageDir;
}

async function assertBothValidatorsReject(packageDir, pattern) {
  await assert.rejects(validatePackage(packageDir, "hermes"), pattern);
  const python = spawnSync(
    pythonCommand.executable,
    [...pythonCommand.args,
      path.resolve(import.meta.dirname, "../../validate_agent_extension.py"),
      packageDir
    ],
    { encoding: "utf8" }
  );
  assert.notEqual(python.status, 0);
  assert.match(python.stderr, pattern);
}

async function temporaryFixture() {
  const root = await temporaryRoot();
  return writeFixture(path.join(root, "package"));
}

async function mutateManifest(packageDir, mutate) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeFixture(packageDir) {
  await mkdir(path.join(packageDir, "profiles"), { recursive: true });
  await mkdir(path.join(packageDir, "assets"), { recursive: true });
  await mkdir(path.join(packageDir, "locales"), { recursive: true });
  await writeFile(
    path.join(packageDir, "tutti.agent.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.agent.manifest.v2",
        agentKey: "hermes",
        version: "1.0.0",
        name: "Hermes Agent",
        icon: { type: "asset", src: "assets/icon.svg" },
        heroImage: { type: "asset", src: "assets/hero-image.jpg" },
        runtime: {
          kind: "standard-acp",
          install: {
            runner: "uv",
            args: ["tool", "install", "hermes-agent[acp]==0.19.0"]
          },
          launch: {
            executable: "${installRoot}/bin/hermes",
            args: ["acp"]
          }
        },
        profiles: { discovery: "profiles/discovery.json" },
        localizationInfo: {
          defaultLocale: "en",
          defaultFile: "locales/en.json"
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(packageDir, "profiles", "discovery.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.agent.discovery.v1",
        candidates: [
          {
            binaryNames: ["hermes"],
            version: { args: ["--version"], constraint: ">=0.19.0 <0.20.0" },
            launchArgs: ["acp"],
            probe: { kind: "acp-initialize", timeoutMs: 5000 }
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    Buffer.from(
      "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4K",
      "base64"
    )
  );
  await writeFile(
    path.join(packageDir, "assets", "hero-image.jpg"),
    "hero-image"
  );
  await writeFile(
    path.join(packageDir, "locales", "en.json"),
    '{"agent.name":"Hermes Agent"}\n'
  );
  return packageDir;
}
