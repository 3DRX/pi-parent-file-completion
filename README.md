# pi-extensions-lab

Pi agent extensions by [3DRX](https://github.com/3DRX).

This repository is intended to hold small, focused extensions that make coding-agent workflows better. Each extension lives in `packages/<extension-name>` and can be developed, tested, and eventually shipped independently.

## Packages

| Package | Description |
|---|---|
| [`packages/parent-file-completion`](packages/parent-file-completion) | Pi extension that adds fuzzy autocomplete for parent-relative `@../...` file references. |
| [`packages/side-chat`](packages/side-chat) | Pi extension that adds ephemeral side chats in a right-side overlay panel. |

## Development

Requirements:

- Node.js
- pnpm
- Pi, for manual extension testing

Install dependencies:

```bash
pnpm install
```

Typecheck all packages:

```bash
pnpm typecheck
```

Dry-run package tarballs:

```bash
pnpm pack:dry-run
```

## Loading all extensions locally in Pi

The monorepo root is also a Pi package. To install all extensions exposed by this repo:

```bash
pi install /absolute/path/to/pi-extensions-lab
```

For one-off testing without installing:

```bash
pi -e /absolute/path/to/pi-extensions-lab
```

## Loading a single extension

You can also load an individual extension file:

```bash
pi -e /absolute/path/to/pi-extensions-lab/packages/parent-file-completion/src/index.ts
```
