#!/usr/bin/env python3
"""Validate a declarative Tutti Agent Extension package without network access."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Any

MANIFEST_SCHEMA = "tutti.agent.manifest.v2"
PROFILE_SCHEMAS = {
    "discovery": "tutti.agent.discovery.v1",
    "tools": "tutti.agent.tools.v1",
    "capabilities": "tutti.agent.capabilities.v1",
    "composer": "tutti.agent.composer.v1",
    "accountUsage": "tutti.agent.account-usage-probe.v1",
}
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
EXACT_NPM_PACKAGE = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@"
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
EXACT_UV_PACKAGE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?=="
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[A-Za-z0-9._+-]*)?$"
)
BINARY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")
PRESENTATION_ASSET_LIMIT = 256 << 10
ALLOWED_PACKAGE_EXTENSIONS = {
    ".json",
    ".md",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
}
ALLOWED_PACKAGE_DOCS = {"AGENTS.md", "README.md", "LICENSE", "NOTICE"}
PERMISSION_SEMANTICS = {
    "read-only",
    "ask-before-write",
    "accept-edits",
    "full-access",
}
TOOL_CATEGORIES = {"file-change", "command", "read", "search", "web"}
TOOL_RENDERERS = {"diff", "terminal", "code", "file-list", "web-fetch"}
CAPABILITY_NAMES = {
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
    "skills",
}
SLASH_COMMAND_EFFECTS = {
    "submitImmediate",
    "showStatus",
    "activateGoalMode",
    "togglePlanMode",
}


class ValidationError(Exception):
    pass


def reject_unknown_keys(
    value: dict[str, Any], allowed: set[str], field: str
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValidationError(
            f"{field} contains unsupported fields: {', '.join(unknown)}"
        )


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"expected JSON object: {path}")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string")
    return value


def require_string_array(
    value: Any, field: str, *, non_empty: bool = False
) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValidationError(f"{field} must be a string array")
    if non_empty and not value:
        raise ValidationError(f"{field} must not be empty")
    return value


def require_safe_relative_path(value: Any, field: str) -> str:
    path = require_string(value, field)
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or "\\" in path:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    return path


def resolve_reference(root: Path, value: Any, field: str) -> Path:
    reference = require_string(value, field)
    pure = PurePosixPath(reference)
    if pure.is_absolute() or ".." in pure.parts or "\\" in reference:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    resolved = (root / Path(*pure.parts)).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValidationError(f"{field} escapes package root") from exc
    if not resolved.is_file():
        raise ValidationError(f"{field} does not exist: {reference}")
    return resolved


def validate_presentation_asset(root: Path, descriptor: Any, field: str) -> Path:
    if not isinstance(descriptor, dict) or descriptor.get("type") != "asset":
        raise ValidationError(f"{field} must be an extension asset")
    reject_unknown_keys(descriptor, {"type", "src"}, field)
    path = resolve_reference(root, descriptor.get("src"), f"{field}.src")
    if path.stat().st_size > PRESENTATION_ASSET_LIMIT:
        raise ValidationError(f"{field} exceeds the 256 KiB presentation asset limit")
    content_type, _ = mimetypes.guess_type(path.name)
    if not content_type or not content_type.startswith("image/"):
        raise ValidationError(f"{field} must use a supported image file type")
    if path.suffix.lower() == ".svg":
        try:
            lower = path.read_text(encoding="utf-8").lower()
        except UnicodeDecodeError as exc:
            raise ValidationError(f"{field} SVG must be valid UTF-8") from exc
        active = re.search(
            r"<(?:[a-z_][\w.-]*:)?(?:script|foreignobject|style|set|animate|"
            r"animatemotion|animatetransform|discard|handler|listener|audio|video|"
            r"iframe|object|embed)\b|javascript:|"
            r"\s(?:[a-z_][\w.-]*:)?(?:on[a-z][\w.-]*|style)\s*=|"
            r"\sxml:base\s*=|@import|<!doctype|<!entity|&#|\\",
            lower,
        )
        remote_href = any(
            not match.group(2).strip().startswith("#")
            for match in re.finditer(
                r"(?:xlink:)?href\s*=\s*(['\"])(.*?)\1",
                lower,
                re.DOTALL,
            )
        )
        remote_url = any(
            not match.group(2).strip().startswith("#")
            for match in re.finditer(
                r"url\s*\(\s*(['\"]?)(.*?)\1\s*\)",
                lower,
                re.DOTALL,
            )
        )
        if active or remote_href or remote_url:
            raise ValidationError(f"{field} SVG contains active or remote content")
    return path


def check_package_tree(root: Path) -> None:
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            raise ValidationError(f"hidden package entries are not allowed: {relative}")
        if path.is_symlink():
            raise ValidationError(f"symlinks are not allowed: {relative}")
        mode = path.stat().st_mode
        if path.is_file() and mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            raise ValidationError(f"executable files are not allowed: {relative}")
        if (
            path.is_file()
            and path.suffix.lower() not in ALLOWED_PACKAGE_EXTENSIONS
            and relative.as_posix() not in ALLOWED_PACKAGE_DOCS
        ):
            raise ValidationError(f"forbidden package file type: {relative}")
        if any(part in {".git", "node_modules"} for part in relative.parts):
            raise ValidationError(f"development directory is not allowed: {relative}")


def check_declared_package_files(root: Path, declared: set[Path]) -> None:
    allowed = {path.resolve() for path in declared}
    for document in ALLOWED_PACKAGE_DOCS:
        candidate = root / document
        if candidate.is_file():
            allowed.add(candidate.resolve())
    for path in root.rglob("*"):
        if path.is_file() and path.resolve() not in allowed:
            raise ValidationError(
                f"package file is not declared by the manifest: {path.relative_to(root)}"
            )


def check_install(runtime: dict[str, Any]) -> None:
    reject_unknown_keys(runtime, {"kind", "install", "launch"}, "runtime")
    if runtime.get("kind") != "standard-acp":
        raise ValidationError("runtime.kind must be standard-acp")
    install = runtime.get("install")
    launch = runtime.get("launch")
    if not isinstance(install, dict) or not isinstance(launch, dict):
        raise ValidationError("runtime.install and runtime.launch must be objects")
    reject_unknown_keys(install, {"runner", "args"}, "runtime.install")
    reject_unknown_keys(
        launch, {"executable", "args", "publishUserCommand"}, "runtime.launch"
    )
    runner = install.get("runner")
    if runner not in {"npm", "pnpm", "uv"}:
        raise ValidationError("runtime.install.runner must be npm, pnpm, or uv")
    args = require_string_array(
        install.get("args"), "runtime.install.args", non_empty=True
    )
    package_pattern = EXACT_UV_PACKAGE if runner == "uv" else EXACT_NPM_PACKAGE
    packages = [arg for arg in args if package_pattern.fullmatch(arg)]
    if len(packages) != 1:
        syntax = "package==version" if runner == "uv" else "package@version"
        raise ValidationError(
            f"install args must contain exactly one exact {runner} {syntax}"
        )
    package = packages[0]
    expected_args = {
        "npm": ["install", "--prefix", "${installRoot}", package],
        "pnpm": ["add", "--dir", "${installRoot}", package],
        "uv": ["tool", "install", package],
    }
    if args != expected_args[runner]:
        raise ValidationError(
            f"runtime install args must use the constrained {runner} install form"
        )
    executable = require_string(launch.get("executable"), "runtime.launch.executable")
    if (
        not executable.startswith("${installRoot}/")
        or ".." in PurePosixPath(executable).parts
    ):
        raise ValidationError("launch executable must stay under ${installRoot}")
    require_string_array(launch.get("args"), "runtime.launch.args")
    publish_user_command = launch.get("publishUserCommand")
    if publish_user_command is not None and not isinstance(publish_user_command, bool):
        raise ValidationError("runtime.launch.publishUserCommand must be a boolean")


def validate_discovery_profile(profile: dict[str, Any]) -> None:
    reject_unknown_keys(profile, {"schemaVersion", "candidates"}, "discovery")
    candidates = profile.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValidationError("discovery.candidates must be a non-empty array")
    for index, candidate in enumerate(candidates):
        field = f"discovery.candidates[{index}]"
        if not isinstance(candidate, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(
            candidate,
            {"binaryNames", "version", "launchArgs", "probe"},
            field,
        )
        binaries = require_string_array(
            candidate.get("binaryNames"), f"{field}.binaryNames", non_empty=True
        )
        if any(not BINARY_NAME.fullmatch(binary) for binary in binaries):
            raise ValidationError(
                f"{field}.binaryNames contains an invalid binary name"
            )
        version = candidate.get("version")
        if not isinstance(version, dict):
            raise ValidationError(f"{field}.version must be an object")
        reject_unknown_keys(version, {"args", "constraint"}, f"{field}.version")
        require_string_array(
            version.get("args"), f"{field}.version.args", non_empty=True
        )
        require_string(version.get("constraint"), f"{field}.version.constraint")
        require_string_array(candidate.get("launchArgs"), f"{field}.launchArgs")
        probe = candidate.get("probe")
        if not isinstance(probe, dict) or probe.get("kind") != "acp-initialize":
            raise ValidationError(f"{field}.probe.kind must be acp-initialize")
        reject_unknown_keys(probe, {"kind", "timeoutMs"}, f"{field}.probe")
        timeout_ms = probe.get("timeoutMs")
        if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 60_000:
            raise ValidationError(f"{field}.probe.timeoutMs must be 100..60000")


def validate_tools_profile(profile: dict[str, Any]) -> None:
    reject_unknown_keys(profile, {"schemaVersion", "tools"}, "tools")
    tools = profile.get("tools")
    if not isinstance(tools, list):
        raise ValidationError("tools.tools must be an array")
    seen_ids: set[str] = set()
    for index, tool in enumerate(tools):
        field = f"tools.tools[{index}]"
        if not isinstance(tool, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(
            tool,
            {"match", "canonicalId", "category", "presentation", "fileEffect"},
            field,
        )
        match = tool.get("match")
        if not isinstance(match, dict):
            raise ValidationError(f"{field}.match must be an object")
        reject_unknown_keys(match, {"ids"}, f"{field}.match")
        ids = require_string_array(
            match.get("ids"), f"{field}.match.ids", non_empty=True
        )
        if len(ids) != len(set(ids)) or any(not BINARY_NAME.fullmatch(item) for item in ids):
            raise ValidationError(f"{field}.match.ids must contain unique safe tool IDs")
        if seen_ids.intersection(ids):
            raise ValidationError(f"{field}.match.ids duplicates another tool mapping")
        seen_ids.update(ids)
        require_string(tool.get("canonicalId"), f"{field}.canonicalId")
        if tool.get("category") not in TOOL_CATEGORIES:
            raise ValidationError(f"{field}.category is unsupported")
        presentation = tool.get("presentation")
        if not isinstance(presentation, dict):
            raise ValidationError(f"{field}.presentation must be an object")
        reject_unknown_keys(
            presentation, {"renderer", "titleKey"}, f"{field}.presentation"
        )
        if presentation.get("renderer") not in TOOL_RENDERERS:
            raise ValidationError(f"{field}.presentation.renderer is unsupported")
        require_string(presentation.get("titleKey"), f"{field}.presentation.titleKey")
        if "fileEffect" in tool and tool["fileEffect"] != {"source": "acp-content-diff"}:
            raise ValidationError(f"{field}.fileEffect must use acp-content-diff")


def validate_capabilities_profile(profile: dict[str, Any]) -> dict[str, bool]:
    reject_unknown_keys(
        profile, {"schemaVersion", "declared"}, "capabilities"
    )
    declared = profile.get("declared")
    if not isinstance(declared, dict):
        raise ValidationError("capabilities.declared must be an object")
    reject_unknown_keys(declared, CAPABILITY_NAMES, "capabilities.declared")
    if not all(
        isinstance(key, str) and isinstance(value, bool)
        for key, value in declared.items()
    ):
        raise ValidationError("capabilities.declared values must be booleans")
    return declared


def validate_skill_root(root: Any, index: int) -> None:
    field = f"composer.skills.roots[{index}]"
    if not isinstance(root, dict):
        raise ValidationError(f"{field} must be an object")
    reject_unknown_keys(root, {"scope", "path"}, field)
    if root.get("scope") not in {"workspace", "user"}:
        raise ValidationError(f"{field}.scope must be workspace or user")
    require_safe_relative_path(root.get("path"), f"{field}.path")


def validate_slash_commands(value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValidationError("composer.slashCommands must be an object")
    reject_unknown_keys(
        value,
        {"commandCatalogAuthoritative", "commands"},
        "composer.slashCommands",
    )
    authoritative = value.get("commandCatalogAuthoritative")
    if authoritative is not None and not isinstance(authoritative, bool):
        raise ValidationError(
            "composer.slashCommands.commandCatalogAuthoritative must be a boolean"
        )
    commands = value.get("commands")
    if commands is None:
        return
    if not isinstance(commands, list):
        raise ValidationError("composer.slashCommands.commands must be an array")
    names: set[str] = set()
    for index, command in enumerate(commands):
        field = f"composer.slashCommands.commands[{index}]"
        if not isinstance(command, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(command, {"name", "effect"}, field)
        name = require_string(command.get("name"), f"{field}.name").strip()
        if any(character.isspace() for character in name):
            raise ValidationError(f"{field}.name must not contain whitespace")
        if name in names:
            raise ValidationError(f"{field}.name must be unique")
        names.add(name)
        effect = command.get("effect")
        if effect is not None and effect not in SLASH_COMMAND_EFFECTS:
            raise ValidationError(f"{field}.effect is unsupported")


def require_env_name(value: Any, field: str) -> str:
    name = require_string(value, field).strip()
    if not ENV_NAME.fullmatch(name):
        raise ValidationError(f"{field} must be a safe environment variable name")
    return name


def validate_runtime_prep(value: Any) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValidationError("composer.runtimePrep must be an object")
    reject_unknown_keys(value, {"instructionsFile", "home"}, "composer.runtimePrep")
    if "instructionsFile" in value:
        require_safe_relative_path(
            value.get("instructionsFile"), "composer.runtimePrep.instructionsFile"
        )
    home = value.get("home")
    if home is None:
        return
    if not isinstance(home, dict):
        raise ValidationError("composer.runtimePrep.home must be an object")
    reject_unknown_keys(
        home,
        {
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
            "includeUserHomeDir",
        },
        "composer.runtimePrep.home",
    )
    require_env_name(home.get("envVar"), "composer.runtimePrep.home.envVar")
    require_safe_relative_path(home.get("dirName"), "composer.runtimePrep.home.dirName")
    if "sourceEnvVar" in home:
        require_env_name(
            home.get("sourceEnvVar"), "composer.runtimePrep.home.sourceEnvVar"
        )
    if "sourceDefaultRel" in home:
        require_safe_relative_path(
            home.get("sourceDefaultRel"), "composer.runtimePrep.home.sourceDefaultRel"
        )
    copy_files = home.get("copyFiles", [])
    if not isinstance(copy_files, list):
        raise ValidationError("composer.runtimePrep.home.copyFiles must be an array")
    for index, file in enumerate(copy_files):
        require_safe_relative_path(
            file, f"composer.runtimePrep.home.copyFiles[{index}]"
        )
    if "configFile" in home:
        require_safe_relative_path(
            home.get("configFile"), "composer.runtimePrep.home.configFile"
        )
    if home.get("configFormat") not in {None, "yaml"}:
        raise ValidationError("composer.runtimePrep.home.configFormat is unsupported")
    external_dirs_key = home.get("externalDirsKey")
    if external_dirs_key is not None and external_dirs_key != ["skills", "external_dirs"]:
        raise ValidationError("composer.runtimePrep.home.externalDirsKey is unsupported")
    if "userHomeSkillDir" in home:
        require_safe_relative_path(
            home.get("userHomeSkillDir"), "composer.runtimePrep.home.userHomeSkillDir"
        )
    for key in ("includeSkillRoots", "includeUserHomeDir"):
        if key in home and not isinstance(home.get(key), bool):
            raise ValidationError(f"composer.runtimePrep.home.{key} must be a boolean")


def validate_composer_profile(profile: dict[str, Any]) -> bool:
    reject_unknown_keys(
        profile,
        {
            "schemaVersion",
            "model",
            "permission",
            "permissionModes",
            "slashCommands",
            "skills",
            "runtimePrep",
        },
        "composer",
    )
    model = profile.get("model")
    if not isinstance(model, dict) or model.get("source") != "acp-session-models":
        raise ValidationError("composer.model.source must be acp-session-models")
    reject_unknown_keys(model, {"source"}, "composer.model")
    permission = profile.get("permission")
    if (
        not isinstance(permission, dict)
        or permission.get("source") != "acp-session-modes"
    ):
        raise ValidationError("composer.permission.source must be acp-session-modes")
    reject_unknown_keys(permission, {"source"}, "composer.permission")
    modes = profile.get("permissionModes")
    if not isinstance(modes, list):
        raise ValidationError("composer.permissionModes must be an array")
    runtime_ids: set[str] = set()
    for index, mode in enumerate(modes):
        field = f"composer.permissionModes[{index}]"
        if not isinstance(mode, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(mode, {"runtimeId", "semantic", "automaticDecision"}, field)
        runtime_id = require_string(mode.get("runtimeId"), f"{field}.runtimeId").strip()
        if runtime_id in runtime_ids:
            raise ValidationError(f"{field}.runtimeId must be unique")
        runtime_ids.add(runtime_id)
        if mode.get("semantic") not in PERMISSION_SEMANTICS:
            raise ValidationError(f"{field}.semantic is unsupported")
        decision = mode.get("automaticDecision")
        safe_approval = decision == "approved" and mode.get("semantic") == "full-access"
        safe_denial = decision == "denied" and mode.get("semantic") == "read-only"
        if decision is not None and not safe_approval and not safe_denial:
            raise ValidationError(f"{field}.automaticDecision is unsafe")
    validate_slash_commands(profile.get("slashCommands"))
    validate_runtime_prep(profile.get("runtimePrep"))
    skills = profile.get("skills")
    if skills is None:
        return False
    if not isinstance(skills, dict):
        raise ValidationError("composer.skills must be an object")
    reject_unknown_keys(
        skills, {"invocation", "triggerPrefix", "roots"}, "composer.skills"
    )
    if skills.get("invocation") != "textTrigger":
        raise ValidationError("composer.skills.invocation must be textTrigger")
    trigger = require_string(
        skills.get("triggerPrefix"), "composer.skills.triggerPrefix"
    )
    if any(character.isspace() for character in trigger) or len(trigger) > 8:
        raise ValidationError(
            "composer.skills.triggerPrefix must be a short non-space prefix"
        )
    roots = skills.get("roots")
    if not isinstance(roots, list) or not roots:
        raise ValidationError("composer.skills.roots must be a non-empty array")
    for index, root in enumerate(roots):
        validate_skill_root(root, index)
    return True


def validate_account_usage_profile(profile: dict[str, Any]) -> None:
    reject_unknown_keys(profile, {"schemaVersion", "runtime"}, "accountUsage")
    runtime = profile.get("runtime")
    if not isinstance(runtime, dict):
        raise ValidationError("accountUsage.runtime must be an object")
    reject_unknown_keys(
        runtime,
        {"package", "kind", "script", "args", "timeoutMs"},
        "accountUsage.runtime",
    )
    package = require_string(runtime.get("package"), "accountUsage.runtime.package")
    if not package.startswith("@") or not EXACT_NPM_PACKAGE.fullmatch(package):
        raise ValidationError(
            "accountUsage.runtime.package must use an exact scoped npm version"
        )
    if runtime.get("kind") != "node-script":
        raise ValidationError("accountUsage.runtime.kind must be node-script")
    script = require_string(runtime.get("script"), "accountUsage.runtime.script")
    if not script.startswith("${installRoot}/") or any(
        token in script
        for token in ("|", ";", "&", "`", "\n", "\r", "<", ">", "$(")
    ):
        raise ValidationError(
            "accountUsage.runtime.script must stay under installRoot"
        )
    args = require_string_array(
        runtime.get("args"), "accountUsage.runtime.args", non_empty=True
    )
    if len(args) > 8:
        raise ValidationError("accountUsage.runtime.args must contain 1..8 entries")
    for index, argument in enumerate(args):
        if len(argument) > 128 or any(
            ord(character) < 32 or ord(character) == 127 for character in argument
        ):
            raise ValidationError(f"accountUsage.runtime.args[{index}] is invalid")
    timeout_ms = runtime.get("timeoutMs")
    if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 30_000:
        raise ValidationError("accountUsage.runtime.timeoutMs must be 100..30000")


def validate_profiles(profile_values: dict[str, dict[str, Any]]) -> None:
    validate_discovery_profile(profile_values["discovery"])
    validate_tools_profile(profile_values["tools"])
    capabilities = validate_capabilities_profile(profile_values["capabilities"])
    validate_account_usage_profile(profile_values["accountUsage"])
    composer_has_skills = validate_composer_profile(profile_values["composer"])
    if bool(capabilities.get("skills")) != composer_has_skills:
        raise ValidationError(
            "capabilities.declared.skills must match the composer.skills declaration"
        )


def validate(root: Path) -> None:
    root = root.resolve()
    manifest_path = root / "tutti.agent.json"
    if not root.is_dir() or not manifest_path.is_file():
        raise ValidationError(f"package must contain tutti.agent.json: {root}")
    check_package_tree(root)
    manifest = read_json(manifest_path)
    reject_unknown_keys(
        manifest,
        {
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
            "localizationInfo",
        },
        "manifest",
    )
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA:
        raise ValidationError(f"schemaVersion must be {MANIFEST_SCHEMA}")
    require_string(manifest.get("agentKey"), "agentKey")
    version = require_string(manifest.get("version"), "version")
    if not SEMVER.fullmatch(version):
        raise ValidationError("version must be semantic versioning without a range")
    require_string(manifest.get("name"), "name")
    require_string(manifest.get("description"), "description")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise ValidationError("runtime must be an object")
    check_install(runtime)

    declared_files = {manifest_path.resolve()}
    declared_files.add(
        validate_presentation_asset(root, manifest.get("icon"), "icon").resolve()
    )
    if manifest.get("maskIcon") is not None:
        declared_files.add(
            validate_presentation_asset(
                root, manifest.get("maskIcon"), "maskIcon"
            ).resolve()
        )
    declared_files.add(
        validate_presentation_asset(
            root, manifest.get("heroImage"), "heroImage"
        ).resolve()
    )

    profiles = manifest.get("profiles")
    if not isinstance(profiles, dict):
        raise ValidationError("profiles must be an object")
    reject_unknown_keys(profiles, set(PROFILE_SCHEMAS), "profiles")
    profile_values: dict[str, dict[str, Any]] = {}
    for profile_name, schema in PROFILE_SCHEMAS.items():
        profile_path = resolve_reference(
            root, profiles.get(profile_name), f"profiles.{profile_name}"
        )
        profile = read_json(profile_path)
        if profile.get("schemaVersion") != schema:
            raise ValidationError(f"profiles.{profile_name} must use {schema}")
        profile_values[profile_name] = profile
        declared_files.add(profile_path.resolve())
    validate_profiles(profile_values)

    localization = manifest.get("localizationInfo")
    if not isinstance(localization, dict):
        raise ValidationError("localizationInfo must be an object")
    reject_unknown_keys(
        localization,
        {"defaultLocale", "defaultFile", "additionalLocales"},
        "localizationInfo",
    )
    locale_files = [
        resolve_reference(
            root, localization.get("defaultFile"), "localizationInfo.defaultFile"
        )
    ]
    additional = localization.get("additionalLocales", [])
    if not isinstance(additional, list):
        raise ValidationError("localizationInfo.additionalLocales must be an array")
    for index, locale in enumerate(additional):
        if not isinstance(locale, dict):
            raise ValidationError(f"additionalLocales[{index}] must be an object")
        reject_unknown_keys(
            locale, {"locale", "file"}, f"additionalLocales[{index}]"
        )
        require_string(locale.get("locale"), f"additionalLocales[{index}].locale")
        locale_files.append(
            resolve_reference(
                root, locale.get("file"), f"additionalLocales[{index}].file"
            )
        )
    for locale_file in locale_files:
        declared_files.add(locale_file.resolve())
        locale = read_json(locale_file)
        require_string(locale.get("agent.name"), f"{locale_file.name}.agent.name")
        require_string(
            locale.get("agent.description"), f"{locale_file.name}.agent.description"
        )
    check_declared_package_files(root, declared_files)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "package", type=Path, help="Directory containing tutti.agent.json"
    )
    args = parser.parse_args()
    try:
        validate(args.package)
    except ValidationError as exc:
        print(f"validation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "package": os.fspath(args.package.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
