import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  isRelativePackagePath,
  requireSafeSegment,
  requireSemver,
  requireString
} from "./format.mjs";

export const manifestSchemaVersion = "tutti.agent.manifest.v2";
export const profileSchemas = Object.freeze({
  discovery: "tutti.agent.discovery.v1",
  tools: "tutti.agent.tools.v1",
  capabilities: "tutti.agent.capabilities.v1",
  composer: "tutti.agent.composer.v1",
  events: "tutti.agent.events.v1"
});

const allowedPackageExtensions = new Set([
  ".json",
  ".md",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const allowedPackageDocuments = new Set([
  "AGENTS.md",
  "README.md",
  "LICENSE",
  "NOTICE"
]);
const presentationAssetLimit = 256 * 1024;
const presentationAssetExtensions = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const binaryNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const envName = /^[A-Z_][A-Z0-9_]*$/u;
const permissionSemantics = new Set([
  "read-only",
  "ask-before-write",
  "accept-edits",
  "full-access"
]);
const toolCategories = new Set(["file-change", "command", "read", "search", "web"]);
const toolRenderers = new Set(["diff", "terminal", "code", "file-list", "web-fetch"]);
const capabilityNames = [
  "imageInput",
  "audioInput",
  "embeddedContext",
  "interrupt",
  "resume",
  "permissionModes",
  "modelSelection",
  "commands",
  "browserUse",
  "computerUse",
  "skills"
];
const slashCommandEffects = new Set([
  "submitImmediate",
  "showStatus",
  "activateGoalMode",
  "togglePlanMode"
]);
const allowedPlaceholders = new Set([
  "${projectRoot}",
  "${installRoot}",
  "${platform}"
]);

export async function validatePackage(packageDir, expectedAgentKey) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, expectedAgentKey);
  await validatePackageEntries(packageDir);
  const declaredFiles = await validateReferencedFiles(packageDir, manifest);
  await validateDeclaredPackageEntries(packageDir, declaredFiles);
  return manifest;
}
export function validateManifest(manifest, expectedAgentKey) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("agent manifest must be an object");
  }
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `agent manifest schemaVersion must be ${manifestSchemaVersion}`
    );
  }
  rejectUnknownKeys(
    manifest,
    [
      "schemaVersion",
      "agentKey",
      "version",
      "name",
      "description",
      "icon",
      "maskIcon",
      "heroImage",
      "runtime",
      "profiles",
      "localizationInfo"
    ],
    "manifest"
  );
  manifest.agentKey = requireSafeSegment(
    manifest.agentKey,
    "manifest agentKey"
  );
  if (expectedAgentKey && manifest.agentKey !== expectedAgentKey) {
    throw new Error(
      `manifest agentKey ${manifest.agentKey} does not match ${expectedAgentKey}`
    );
  }
  manifest.version = requireSemver(manifest.version, "manifest version");
  requireString(manifest.name, "manifest name");
  if (manifest.description !== undefined) {
    requireString(manifest.description, "manifest description");
  }
  validateIcon(manifest.icon);
  if (manifest.maskIcon !== undefined) {
    validateMaskIcon(manifest.maskIcon);
  }
  if (manifest.heroImage !== undefined) {
    validateHeroImage(manifest.heroImage);
  }
  validateRuntime(manifest.runtime);
  validateProfiles(manifest.profiles);
  validateLocalizationInfo(manifest.localizationInfo);
  return manifest;
}

function validateIcon(icon) {
  if (!icon || typeof icon !== "object" || icon.type !== "asset") {
    throw new Error("manifest icon.type must be asset");
  }
  rejectUnknownKeys(icon, ["type", "src"], "manifest icon");
  requireRelativePath(icon.src, "manifest icon.src");
}

function validateHeroImage(heroImage) {
  if (
    !heroImage ||
    typeof heroImage !== "object" ||
    heroImage.type !== "asset"
  ) {
    throw new Error("manifest heroImage.type must be asset");
  }
  rejectUnknownKeys(heroImage, ["type", "src"], "manifest heroImage");
  requireRelativePath(heroImage.src, "manifest heroImage.src");
}

function validateMaskIcon(maskIcon) {
  if (!maskIcon || typeof maskIcon !== "object" || maskIcon.type !== "asset") {
    throw new Error("manifest maskIcon.type must be asset");
  }
  rejectUnknownKeys(maskIcon, ["type", "src"], "manifest maskIcon");
  requireRelativePath(maskIcon.src, "manifest maskIcon.src");
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("manifest runtime is required");
  }
  if (runtime.kind !== "standard-acp") {
    throw new Error("manifest runtime.kind must be standard-acp");
  }
  rejectUnknownKeys(runtime, ["kind", "install", "launch"], "manifest runtime");
  validateInstall(runtime.install);
  if (!runtime.launch || typeof runtime.launch !== "object") {
    throw new Error("manifest runtime.launch is required");
  }
  rejectUnknownKeys(runtime.launch, ["executable", "args"], "runtime launch");
  const executable = requireString(
    runtime.launch.executable,
    "runtime launch executable"
  );
  validateTemplateArgument(executable, "runtime launch executable");
  if (
    !executable.startsWith("${installRoot}/") ||
    executable.includes("\\") ||
    executable.split("/").includes("..")
  ) {
    throw new Error("runtime launch executable must stay under ${installRoot}");
  }
  validateArgv(runtime.launch.args ?? [], "runtime launch args");
}

function validateInstall(install) {
  if (!install || typeof install !== "object") {
    throw new Error("manifest runtime.install is required");
  }
  if (!new Set(["npm", "pnpm", "uv"]).has(install.runner)) {
    throw new Error("runtime install runner must be npm, pnpm, or uv");
  }
  rejectUnknownKeys(install, ["runner", "args"], "runtime install");
  validateArgv(install.args, "runtime install args");
  if (install.runner !== "uv" && !install.args.some((argument) => argument.includes("${installRoot}"))) {
    throw new Error("runtime install args must target ${installRoot}");
  }
  if (install.runner === "npm" || install.runner === "pnpm") {
    const packageArguments = install.args.filter((argument) =>
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error(
        "npm/pnpm install must contain one exact package@version"
      );
    }
    const expected = install.runner === "npm"
      ? ["install", "--prefix", "${installRoot}", packageArguments[0]]
      : ["add", "--dir", "${installRoot}", packageArguments[0]];
    if (JSON.stringify(install.args) !== JSON.stringify(expected)) {
      throw new Error(
        `runtime ${install.runner} install must use the constrained install form`
      );
    }
  } else {
    const packageArguments = install.args.filter((argument) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?==[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error("uv install must contain one exact package==version");
    }
    const expected = ["tool", "install", packageArguments[0]];
    if (JSON.stringify(install.args) !== JSON.stringify(expected)) {
      throw new Error("runtime uv install must use the constrained install form");
    }
  }
}

function validateArgv(argv, label) {
  if (!Array.isArray(argv)) throw new Error(`${label} must be an array`);
  for (const [index, argument] of argv.entries()) {
    validateTemplateArgument(
      requireString(argument, `${label}[${index}]`),
      `${label}[${index}]`
    );
  }
}

function validateTemplateArgument(argument, label) {
  if (/[|;&`\n\r<>]/u.test(argument) || argument.includes("$(")) {
    throw new Error(`${label} contains forbidden shell syntax`);
  }
  for (const match of argument.matchAll(/\$\{[^}]+\}/gu)) {
    if (!allowedPlaceholders.has(match[0])) {
      throw new Error(`${label} contains unsupported placeholder ${match[0]}`);
    }
  }
}

function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("manifest profiles is required");
  }
  for (const [kind, file] of Object.entries(profiles)) {
    if (!Object.hasOwn(profileSchemas, kind)) {
      throw new Error(`manifest profiles.${kind} is unsupported`);
    }
    requireRelativePath(file, `manifest profiles.${kind}`);
  }
  if (!profiles.discovery) {
    throw new Error("manifest profiles.discovery is required");
  }
}

function validateLocalizationInfo(localizationInfo) {
  if (!localizationInfo || typeof localizationInfo !== "object") {
    throw new Error("manifest localizationInfo is required");
  }
  rejectUnknownKeys(
    localizationInfo,
    ["defaultLocale", "defaultFile", "additionalLocales"],
    "manifest localizationInfo"
  );
  requireString(
    localizationInfo.defaultLocale,
    "localizationInfo defaultLocale"
  );
  requireRelativePath(
    localizationInfo.defaultFile,
    "localizationInfo defaultFile"
  );
  const additional = localizationInfo.additionalLocales ?? [];
  if (!Array.isArray(additional)) {
    throw new Error("localizationInfo additionalLocales must be an array");
  }
  for (const [index, locale] of additional.entries()) {
    if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
      throw new Error(`additionalLocales[${index}] must be an object`);
    }
    rejectUnknownKeys(
      locale,
      ["locale", "file"],
      `additionalLocales[${index}]`
    );
    requireString(locale?.locale, `additionalLocales[${index}].locale`);
    requireRelativePath(locale?.file, `additionalLocales[${index}].file`);
  }
}

async function validateReferencedFiles(packageDir, manifest) {
  const references = [
    [manifest.icon.src, null],
    ...(manifest.maskIcon ? [[manifest.maskIcon.src, null]] : []),
    ...(manifest.heroImage ? [[manifest.heroImage.src, null]] : []),
    [manifest.localizationInfo.defaultFile, null],
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => [
      entry.file,
      null
    ]),
    ...Object.entries(manifest.profiles).map(([kind, file]) => [
      file,
      profileSchemas[kind]
    ])
  ];
  const declaredFiles = new Set([path.resolve(packageDir, "tutti.agent.json")]);
  const profileValues = {};
  for (const [relativePath, expectedSchema] of references) {
    const filePath = resolvePackagePath(packageDir, relativePath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(
        `referenced package file is missing or empty: ${relativePath}`
      );
    }
    declaredFiles.add(filePath);
    if (relativePath === manifest.icon.src || relativePath === manifest.maskIcon?.src || relativePath === manifest.heroImage?.src) {
      await validatePresentationAsset(filePath, relativePath, info);
    }
    if (expectedSchema) {
      const profile = JSON.parse(await readFile(filePath, "utf8"));
      const kind = Object.entries(profileSchemas).find(
        ([_kind, schema]) => schema === expectedSchema
      )?.[0];
      if (profile.schemaVersion !== expectedSchema) {
        throw new Error(
          `${relativePath} schemaVersion must be ${expectedSchema}`
        );
      }
      validateProfileShape(kind, profile);
      profileValues[kind] = profile;
    }
  }
  validateProfileAgreement(profileValues);
  return declaredFiles;
}

function validateProfileShape(kind, profile) {
  if (kind === "discovery") {
    rejectUnknownKeys(profile, ["schemaVersion", "candidates"], kind);
    if (!Array.isArray(profile.candidates) || profile.candidates.length === 0) {
      throw new Error("discovery.candidates must be a non-empty array");
    }
    for (const [index, candidate] of profile.candidates.entries()) {
      const label = `discovery.candidates[${index}]`;
      rejectObjectKeys(
        candidate,
        ["binaryNames", "version", "launchArgs", "probe"],
        label
      );
      validateStringArray(candidate.binaryNames, `${label}.binaryNames`, true);
      if (candidate.binaryNames.some((name) => !binaryNamePattern.test(name))) {
        throw new Error(`${label}.binaryNames contains an invalid binary name`);
      }
      rejectObjectKeys(
        candidate?.version,
        ["args", "constraint"],
        `${label}.version`
      );
      validateStringArray(candidate.version.args, `${label}.version.args`, true);
      requireString(candidate.version.constraint, `${label}.version.constraint`);
      validateStringArray(candidate.launchArgs, `${label}.launchArgs`);
      rejectObjectKeys(
        candidate?.probe,
        ["kind", "timeoutMs"],
        `${label}.probe`
      );
      if (candidate.probe.kind !== "acp-initialize") {
        throw new Error(`${label}.probe.kind must be acp-initialize`);
      }
      if (
        !Number.isInteger(candidate.probe.timeoutMs) ||
        candidate.probe.timeoutMs < 100 ||
        candidate.probe.timeoutMs > 60_000
      ) {
        throw new Error(`${label}.probe.timeoutMs must be 100..60000`);
      }
    }
    return;
  }
  if (kind === "tools") {
    rejectUnknownKeys(profile, ["schemaVersion", "tools"], kind);
    if (!Array.isArray(profile.tools)) {
      throw new Error("tools.tools must be an array");
    }
    const seenIds = new Set();
    for (const [index, tool] of profile.tools.entries()) {
      const label = `tools.tools[${index}]`;
      rejectObjectKeys(
        tool,
        ["match", "canonicalId", "category", "presentation", "fileEffect"],
        label
      );
      rejectObjectKeys(tool?.match, ["ids"], `${label}.match`);
      validateStringArray(tool.match.ids, `${label}.match.ids`, true);
      const ids = new Set(tool.match.ids);
      if (
        ids.size !== tool.match.ids.length ||
        tool.match.ids.some((id) => !binaryNamePattern.test(id))
      ) {
        throw new Error(`${label}.match.ids must contain unique safe tool IDs`);
      }
      if (tool.match.ids.some((id) => seenIds.has(id))) {
        throw new Error(`${label}.match.ids duplicates another tool mapping`);
      }
      tool.match.ids.forEach((id) => seenIds.add(id));
      requireString(tool.canonicalId, `${label}.canonicalId`);
      if (!toolCategories.has(tool.category)) {
        throw new Error(`${label}.category is unsupported`);
      }
      rejectObjectKeys(
        tool?.presentation,
        ["renderer", "titleKey"],
        `${label}.presentation`
      );
      if (!toolRenderers.has(tool.presentation.renderer)) {
        throw new Error(`${label}.presentation.renderer is unsupported`);
      }
      requireString(tool.presentation.titleKey, `${label}.presentation.titleKey`);
      if (tool?.fileEffect !== undefined) {
        rejectObjectKeys(
          tool.fileEffect,
          ["source"],
          `${label}.fileEffect`
        );
        if (tool.fileEffect.source !== "acp-content-diff") {
          throw new Error(`${label}.fileEffect must use acp-content-diff`);
        }
      }
    }
    return;
  }
  if (kind === "capabilities") {
    rejectUnknownKeys(profile, ["schemaVersion", "declared"], kind);
    rejectObjectKeys(
      profile.declared,
      capabilityNames,
      "capabilities.declared"
    );
    if (Object.values(profile.declared).some((value) => typeof value !== "boolean")) {
      throw new Error("capabilities.declared values must be booleans");
    }
    return;
  }
  if (kind === "composer") {
    rejectUnknownKeys(
      profile,
      [
        "schemaVersion",
        "model",
        "permission",
        "permissionModes",
        "slashCommands",
        "skills",
        "runtimePrep"
      ],
      kind
    );
    rejectObjectKeys(profile.model, ["source"], "composer.model");
    if (profile.model.source !== "acp-session-models") {
      throw new Error("composer.model.source must be acp-session-models");
    }
    rejectObjectKeys(profile.permission, ["source"], "composer.permission");
    if (profile.permission.source !== "acp-session-modes") {
      throw new Error("composer.permission.source must be acp-session-modes");
    }
    if (!Array.isArray(profile.permissionModes)) {
      throw new Error("composer.permissionModes must be an array");
    }
    const runtimeIds = new Set();
    for (const [index, mode] of profile.permissionModes.entries()) {
      const label = `composer.permissionModes[${index}]`;
      rejectObjectKeys(
        mode,
        ["runtimeId", "semantic", "automaticDecision"],
        label
      );
      const runtimeId = requireString(mode.runtimeId, `${label}.runtimeId`).trim();
      if (runtimeIds.has(runtimeId)) {
        throw new Error(`${label}.runtimeId must be unique`);
      }
      runtimeIds.add(runtimeId);
      if (!permissionSemantics.has(mode.semantic)) {
        throw new Error(`${label}.semantic is unsupported`);
      }
      if (mode.automaticDecision !== undefined) {
        const safeApproval = mode.automaticDecision === "approved" && mode.semantic === "full-access";
        const safeDenial = mode.automaticDecision === "denied" && mode.semantic === "read-only";
        if (!safeApproval && !safeDenial) throw new Error(`${label}.automaticDecision is unsafe`);
      }
    }
    validateSlashCommands(profile.slashCommands);
    validateRuntimePrep(profile.runtimePrep);
    if (profile.skills !== undefined) {
      rejectObjectKeys(
        profile.skills,
        ["invocation", "triggerPrefix", "roots"],
        "composer.skills"
      );
      if (profile.skills.invocation !== "textTrigger") {
        throw new Error("composer.skills.invocation must be textTrigger");
      }
      const trigger = requireString(
        profile.skills.triggerPrefix,
        "composer.skills.triggerPrefix"
      );
      if (/\s/u.test(trigger) || trigger.length > 8) {
        throw new Error("composer.skills.triggerPrefix must be a short non-space prefix");
      }
      if (!Array.isArray(profile.skills.roots) || profile.skills.roots.length === 0) {
        throw new Error("composer.skills.roots must be a non-empty array");
      }
      for (const [index, root] of profile.skills.roots.entries()) {
        const label = `composer.skills.roots[${index}]`;
        rejectObjectKeys(
          root,
          ["scope", "path"],
          label
        );
        if (root.scope !== "workspace" && root.scope !== "user") {
          throw new Error(`${label}.scope must be workspace or user`);
        }
        requireSafeRelativePath(root.path, `${label}.path`);
      }
    }
    return;
  }
  if (kind === "events") {
    rejectUnknownKeys(profile, ["schemaVersion", "events"], kind);
  }
}

function validateSlashCommands(slashCommands) {
  if (slashCommands === undefined) return;
  rejectObjectKeys(
    slashCommands,
    ["commandCatalogAuthoritative", "commands"],
    "composer.slashCommands"
  );
  if (
    slashCommands.commandCatalogAuthoritative !== undefined &&
    typeof slashCommands.commandCatalogAuthoritative !== "boolean"
  ) {
    throw new Error("composer.slashCommands.commandCatalogAuthoritative must be a boolean");
  }
  if (slashCommands.commands === undefined) return;
  if (!Array.isArray(slashCommands.commands)) {
    throw new Error("composer.slashCommands.commands must be an array");
  }
  const names = new Set();
  for (const [index, command] of slashCommands.commands.entries()) {
    const label = `composer.slashCommands.commands[${index}]`;
    rejectObjectKeys(command, ["name", "effect"], label);
    const name = requireString(command.name, `${label}.name`).trim();
    if (/\s/u.test(name)) {
      throw new Error(`${label}.name must not contain whitespace`);
    }
    if (names.has(name)) {
      throw new Error(`${label}.name must be unique`);
    }
    names.add(name);
    if (
      command.effect !== undefined &&
      !slashCommandEffects.has(command.effect)
    ) {
      throw new Error(`${label}.effect is unsupported`);
    }
  }
}

function requireEnvName(value, label) {
  const normalized = requireString(value, label).trim();
  if (!envName.test(normalized)) {
    throw new Error(`${label} must be a safe environment variable name`);
  }
  return normalized;
}

function validateRuntimePrep(runtimePrep) {
  if (runtimePrep === undefined) return;
  rejectObjectKeys(runtimePrep, ["instructionsFile", "home"], "composer.runtimePrep");
  if (runtimePrep.instructionsFile !== undefined) {
    requireSafeRelativePath(
      runtimePrep.instructionsFile,
      "composer.runtimePrep.instructionsFile"
    );
  }
  if (runtimePrep.home === undefined) return;
  rejectObjectKeys(
    runtimePrep.home,
    [
      "envVar",
      "dirName",
      "sourceEnvVar",
      "sourceDefaultRel",
      "copyFiles",
      "configFile",
      "configFormat",
      "externalDirsKey",
      "userHomeSkillDir",
      "includeSkillRoots",
      "includeUserHomeDir"
    ],
    "composer.runtimePrep.home"
  );
  requireEnvName(runtimePrep.home.envVar, "composer.runtimePrep.home.envVar");
  requireSafeRelativePath(runtimePrep.home.dirName, "composer.runtimePrep.home.dirName");
  if (runtimePrep.home.sourceEnvVar !== undefined) {
    requireEnvName(
      runtimePrep.home.sourceEnvVar,
      "composer.runtimePrep.home.sourceEnvVar"
    );
  }
  if (runtimePrep.home.sourceDefaultRel !== undefined) {
    requireSafeRelativePath(
      runtimePrep.home.sourceDefaultRel,
      "composer.runtimePrep.home.sourceDefaultRel"
    );
  }
  const copyFiles = runtimePrep.home.copyFiles ?? [];
  if (!Array.isArray(copyFiles)) {
    throw new Error("composer.runtimePrep.home.copyFiles must be an array");
  }
  for (const [index, file] of copyFiles.entries()) {
    requireSafeRelativePath(file, `composer.runtimePrep.home.copyFiles[${index}]`);
  }
  if (runtimePrep.home.configFile !== undefined) {
    requireSafeRelativePath(
      runtimePrep.home.configFile,
      "composer.runtimePrep.home.configFile"
    );
  }
  if (
    runtimePrep.home.configFormat !== undefined &&
    runtimePrep.home.configFormat !== "yaml"
  ) {
    throw new Error("composer.runtimePrep.home.configFormat is unsupported");
  }
  if (
    runtimePrep.home.externalDirsKey !== undefined &&
    JSON.stringify(runtimePrep.home.externalDirsKey) !== JSON.stringify(["skills", "external_dirs"])
  ) {
    throw new Error("composer.runtimePrep.home.externalDirsKey is unsupported");
  }
  if (runtimePrep.home.userHomeSkillDir !== undefined) {
    requireSafeRelativePath(
      runtimePrep.home.userHomeSkillDir,
      "composer.runtimePrep.home.userHomeSkillDir"
    );
  }
  for (const key of ["includeSkillRoots", "includeUserHomeDir"]) {
    if (
      runtimePrep.home[key] !== undefined &&
      typeof runtimePrep.home[key] !== "boolean"
    ) {
      throw new Error(`composer.runtimePrep.home.${key} must be a boolean`);
    }
  }
}

function validateProfileAgreement(profiles) {
  if (!profiles.capabilities || !profiles.composer) return;
  const declaresSkills = Boolean(profiles.capabilities.declared.skills);
  const composerHasSkills = profiles.composer.skills !== undefined;
  if (declaresSkills !== composerHasSkills) {
    throw new Error(
      "capabilities.declared.skills must match the composer.skills declaration"
    );
  }
}

function rejectObjectKeys(value, allowedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  rejectUnknownKeys(value, allowedKeys, label);
}

async function validatePresentationAsset(filePath, relativePath, info) {
  if (info.size > presentationAssetLimit) {
    throw new Error(`presentation asset exceeds 256 KiB: ${relativePath}`);
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (!presentationAssetExtensions.has(extension)) {
    throw new Error(`presentation asset must use a supported image file type: ${relativePath}`);
  }
  if (extension !== ".svg") return;
  const source = (await readFile(filePath, "utf8")).toLowerCase();
  if (hasActiveOrRemoteSVGContent(source)) {
    throw new Error(`SVG asset contains active or remote content: ${relativePath}`);
  }
}

function hasActiveOrRemoteSVGContent(source) {
  if (
    /<(?:[a-z_][\w.-]*:)?(?:script|foreignobject|style|set|animate|animatemotion|animatetransform|discard|handler|listener|audio|video|iframe|object|embed)\b|javascript:|\s(?:[a-z_][\w.-]*:)?(?:on[a-z][\w.-]*|style)\s*=|\sxml:base\s*=|@import|<!doctype|<!entity|&#|\\/u.test(
      source
    )
  ) {
    return true;
  }
  for (const match of source.matchAll(/(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gsu)) {
    if (!match[2].trim().startsWith("#")) return true;
  }
  for (const match of source.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gsu)) {
    if (!match[2].trim().startsWith("#")) return true;
  }
  return false;
}

async function validateDeclaredPackageEntries(root, declaredFiles, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.resolve(root, relativePath);
    if (entry.isDirectory()) {
      await validateDeclaredPackageEntries(root, declaredFiles, relativePath);
      continue;
    }
    if (
      entry.isFile() &&
      !declaredFiles.has(absolutePath) &&
      !(relativeDir === "" && allowedPackageDocuments.has(entry.name))
    ) {
      throw new Error(`package file is not declared by the manifest: ${relativePath}`);
    }
  }
}

async function validatePackageEntries(root, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `agent package must not contain symlinks: ${relativePath}`
      );
    }
    if (entry.name.startsWith(".")) {
      throw new Error(`agent package contains hidden entry: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await validatePackageEntries(root, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `agent package contains unsupported entry: ${relativePath}`
      );
    }
    if (
      !allowedPackageExtensions.has(path.extname(entry.name).toLowerCase()) &&
      !(relativeDir === "" && allowedPackageDocuments.has(entry.name))
    ) {
      throw new Error(
        `agent package contains forbidden file type: ${relativePath}`
      );
    }
    const info = await stat(absolutePath);
    if ((info.mode & 0o111) !== 0) {
      throw new Error(
        `agent package contains executable file: ${relativePath}`
      );
    }
  }
}

function requireRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (!isRelativePackagePath(normalized)) {
    throw new Error(`${label} must be a relative package path`);
  }
  return normalized;
}

function requireSafeRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  return normalized;
}

function validateStringArray(value, label, nonEmpty = false) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  if (nonEmpty && value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function resolvePackagePath(packageDir, relativePath) {
  const resolved = path.resolve(packageDir, relativePath);
  if (!resolved.startsWith(`${path.resolve(packageDir)}${path.sep}`)) {
    throw new Error(`package reference escapes package root: ${relativePath}`);
  }
  return resolved;
}

function rejectUnknownKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
}
