# Contributing

Use Node.js 24 and pnpm 10.11.0. Keep the extension package declarative and
pin every runtime dependency exactly.

Before opening a pull request, run:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Use Conventional Commits and certify every commit with DCO sign-off:

```sh
git commit -s -m "fix(agent): describe the change"
```

Never commit signing keys, cloud credentials, runtime binaries, generated
archives, or `node_modules`.
