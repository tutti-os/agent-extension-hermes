# Runtime verification

The extension contract is pinned to `hermes-agent[acp]==0.18.2` and launches
`hermes acp`. Compatibility is bounded to `>=0.18.2 <0.19.0`; discovery must
complete a standard ACP initialize probe within 15 seconds. The managed runtime
stays private to Tutti and does not publish `~/.local/bin/hermes`, preserving
any user-managed Hermes installation at that path.

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
