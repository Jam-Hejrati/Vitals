# Vitals

> `npm outdated` tells you a newer version exists.
> **Vitals tells you whether the packages you depend on are alive, finished, or dying.**

A package can be fully up to date, have zero known vulnerabilities, and still be abandoned.
Vitals catches that — and tells you which of your direct dependencies pulled it in.

**Status:** early development. Not published yet. See [docs/VISION.md](docs/VISION.md) for the plan.

## Development

Requires Node.js ≥ 22.12 and pnpm 10.

```bash
pnpm install
pnpm build    # compile all packages
pnpm test     # run tests
pnpm lint
```

Try the CLI against a project with a `package-lock.json`:

```bash
node packages/cli/dist/index.js path/to/project
```

## Packages

| Package         | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `packages/core` | Engine: reads lockfiles, fetches signals, computes scores. |
| `packages/cli`  | The `vitals` command-line tool.                            |

## License

[MIT](LICENSE)
