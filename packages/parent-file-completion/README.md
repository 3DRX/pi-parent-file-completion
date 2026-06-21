# pi-parent-file-completion

A small [Pi](https://pi.dev) extension that adds fuzzy file autocomplete for `@../...` references.

Pi already supports `@file` fuzzy completion inside the current working directory. This extension fills the gap when you want to attach or reference files outside the current directory, especially sibling projects:

```text
@../some-file
@../../some-file
@"../folder with spaces/some-file"
```

## What it does

When the editor cursor is inside an `@` file reference whose path starts with `..`, the extension searches from that parent-relative base and returns fuzzy suggestions.

Examples:

| Typed | Search base | Fuzzy query |
|---|---:|---|
| `@..` | `../` | empty, lists parent entries |
| `@../` | `../` | empty, lists parent entries |
| `@../router` | `../` | `router` |
| `@../../api` | `../../` | `api` |
| `@../sibling/src/use` | `../sibling/src/` | `use` |
| `@"../folder with spaces/use` | `../folder with spaces/` | `use` |

Selecting a directory keeps the cursor inside the path so you can continue completing deeper paths. Paths containing spaces are inserted as quoted `@"..."` references.

## Install / test locally

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-parent-file-completion typecheck
pi -e ./packages/parent-file-completion/src/index.ts
```

Or from another directory:

```bash
pi -e /absolute/path/to/pi-extensions-lab/packages/parent-file-completion/src/index.ts
```

For normal local use, add it to your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/pi-extensions-lab/packages/parent-file-completion/src/index.ts \
  ~/.pi/agent/extensions/parent-file-completion.ts
```

Then restart Pi, or run `/reload` if Pi is already open.

## Package install style

This package can be loaded directly, or as part of the monorepo root Pi package.

Install all extensions exposed by the monorepo root:

```bash
pi install /absolute/path/to/pi-extensions-lab
```

Install only this package:

```bash
pi install /absolute/path/to/pi-extensions-lab/packages/parent-file-completion
```

Project-local install from a project that should use it:

```bash
pi install -l /absolute/path/to/pi-extensions-lab/packages/parent-file-completion
```

## Command

The extension registers:

```text
/parent-completion-status
/parent-completion-status clear
```

Use it to verify that the extension loaded and to clear the in-memory scan cache.

## Configuration flags

These are optional startup flags:

```bash
pi -e ./src/index.ts \
  --parent-completion-max-results 30 \
  --parent-completion-max-depth 8 \
  --parent-completion-max-entries 20000 \
  --parent-completion-cache-ms 15000 \
  --parent-completion-exclude ".git,node_modules,dist,build,.ssh,.gnupg"
```

| Flag | Default | Meaning |
|---|---:|---|
| `--parent-completion-max-results` | `30` | Maximum suggestions to show. |
| `--parent-completion-max-depth` | `8` | Maximum recursive depth for fuzzy searches. |
| `--parent-completion-max-entries` | `20000` | Maximum filesystem entries to scan per base directory. |
| `--parent-completion-cache-ms` | `15000` | Scan cache TTL in milliseconds. |
| `--parent-completion-exclude` | see source | Comma-separated directory/file names to skip. |

## Design notes

- The extension only intercepts `@` references whose path starts with parent-relative `..`.
- All other autocomplete behavior delegates to Pi's existing provider, so normal `@file`, `/commands`, and other extension autocomplete should keep working.
- Empty parent references like `@..` and `@../` list immediate parent entries.
- Non-empty queries like `@../auth` recursively fuzzy-search under the parent base.
- The implementation uses Node's filesystem APIs and does not shell out or make network calls.
- It does not follow symlinked directories, which avoids simple symlink loops.

## Security / privacy

This extension searches outside Pi's current working directory by design. To reduce accidental broad scans, it has depth and entry limits and excludes common heavy or sensitive directories like `.git`, `node_modules`, `.ssh`, and `.gnupg` by default.

No file contents are read. Only directory entries and file names are inspected for autocomplete suggestions.
