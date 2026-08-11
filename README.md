# Hermes Agent Extension for Tutti

This repository connects the official Hermes Agent CLI to Tutti through the
standard Agent Client Protocol (ACP). The signed package is declarative: it
contains metadata, profiles, localized copy, and passive images, but no
executable extension code.

## Runtime contract

- PyPI requirement: `hermes-agent[acp,mcp]==0.18.2`
- Discovery: `hermes --version`
- ACP launch: `hermes acp`
- Managed install: isolated `uv tool install` under the Target runtime root
- User command publication: disabled so an existing `~/.local/bin/hermes`
  remains untouched

The extension does not bundle `uv` or Python. Tutti Desktop supplies its
version-pinned, checksum-verified `uv` archive to tuttid; tuttid extracts that
tool into the host-managed shared tool cache and then performs the existing
dynamic Python package install in the private Target runtime. This keeps the
extension declarative and avoids
duplicating a native toolchain in every agent package.

The signed composer profile maps the ACP-advertised Hermes modes `default`,
`accept_edits`, and `dont_ask` to Tutti `ask-before-write`, `accept-edits`, and
`full-access`. It declares automatic approval only for the `full-access`
semantic tier. The daemon rejects automatic approval on less permissive tiers.

The package declares Hermes-owned slash commands, browser-use support, and
workspace/user Skill roots. Tutti injects its managed runtime Skills through
the host runtime-preparation contract and passes all extension Skill roots to
Hermes through `skills.external_dirs`.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
```

Release publication uses Ed25519 signatures, immutable version objects, and
the shared Tutti Agent Extension CDN. The production private key is stored only
as the `TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret.

Hermes Agent remains an upstream project; this repository owns only Tutti's
declarative integration metadata and release pipeline.
