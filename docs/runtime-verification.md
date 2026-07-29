# Runtime verification

The extension contract is pinned to `hermes-agent[acp]==0.18.2` and launches
`hermes acp`. Compatibility is bounded to `>=0.18.2 <0.19.0`; discovery must
complete a standard ACP initialize probe within 15 seconds. The managed runtime
stays private to Tutti and does not publish `~/.local/bin/hermes`, preserving
any user-managed Hermes installation at that path.
