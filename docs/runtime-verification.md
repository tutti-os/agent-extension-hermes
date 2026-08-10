# Runtime verification

The extension contract is pinned to `hermes-agent[acp]==0.18.2` and launches
`hermes acp`. Compatibility is bounded to `>=0.18.2 <0.19.0`; discovery must
complete a standard ACP initialize probe within 15 seconds. Successful managed
activation publishes `~/.local/bin/hermes` through Tutti's stable user-command
entry. Tutti refuses to replace a foreign command already present at that path.

## Windows host acceptance

Hermes installation on Windows has two dependency-resolution stages. The Tutti
host first resolves its managed `uv` toolchain from the packaged archive,
falling back to an official download only when that resource is absent. Then
`uv tool install` resolves `hermes-agent[acp]==0.18.2` and Python dependencies
over the configured package index. The extension owns only the second-stage
declaration.

For a packaged Windows acceptance run:

1. Start Tutti without `uv` on `PATH` and with GitHub release downloads blocked.
2. Install the Hermes Target and confirm tuttid extracts the packaged,
   checksum-pinned `uv` archive without a request to GitHub.
3. Allow the configured Python package index and confirm the Tutti Target
   status/version probe reports a version in `>=0.18.2 <0.19.0`; open a new
   terminal and confirm `hermes --version` resolves through `~/.local/bin`.
4. Run the standard ACP `initialize` and `session/new` probe.

If step 2 fails, diagnose the Tutti host resource or proxy contract rather than
changing this extension. If step 3 fails, diagnose package-index connectivity;
the current scope does not bundle Hermes or its Python dependency graph.

## Permission modes

An ACP `initialize` plus `session/new` probe against the pinned runtime reports
the following session modes:

| Runtime ID       | Hermes behavior                                                                    | Tutti semantic     |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `default`        | Ask before edits                                                                   | `ask-before-write` |
| `accept_edits`   | Allow workspace and temporary-directory edits; ask for other or sensitive paths   | `accept-edits`     |
| `dont_ask`       | Allow session file edits except sensitive paths                                   | `full-access`      |

Only `dont_ask` declares Tutti automatic approval. Hermes' own hard safety
rules and user-configured deny rules remain authoritative.

The pinned runtime does not advertise a distinct read-only ACP mode. Do not
invent an undeclared runtime ID. The conservative fallback is `default`, where
a rejected edit leaves no file or Git side effect and the session remains
usable.

Local acceptance verification established:

- `default`: reading succeeds; an edit requests approval; rejection leaves the
  requested file absent and Hermes reports that the write was denied.
- `default`: approving one edit performs it once; rejecting the following edit
  leaves the approved result unchanged; a later read in the same session
  succeeds.
- switching a settled session from `default` to `accept_edits` applies to the
  next identical workspace edit without reusing the prior approval; switching
  back to `default` makes the next edit request approval again.

Permission changes are verified between turns. The runtime does not advertise
permission-mode changes during an active turn, so callers must resolve a
pending interaction before changing the mode.
