# pi-tmux-title

A small [Pi](https://pi.dev) extension that changes the terminal and tmux title to `pi` when Pi starts.

This fixes the common tmux behavior where the window/tab title shows `node`, because Pi runs as a Node.js process and tmux's `automatic-rename` feature names the window after the foreground command.

## What it does

On `session_start`, the extension can:

- call `ctx.ui.setTitle("pi")` to set the terminal title;
- run `tmux rename-window pi` to set the tmux window/tab title;
- run `tmux set-window-option automatic-rename off` so tmux does not rename it back to `node`;
- run `tmux select-pane -T pi` to set the pane title too.

By default it snapshots the previous tmux window name and `automatic-rename` value, then restores them on clean Pi shutdown.

## Install / test locally

From the monorepo root:

```bash
pnpm install
pnpm --filter @3drx/pi-tmux-title typecheck
pi -e ./packages/tmux-title/src/index.ts
```

Or from another directory:

```bash
pi -e /absolute/path/to/pi-extensions-lab/packages/tmux-title/src/index.ts
```

For normal local use, add it to your global Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/pi-extensions-lab/packages/tmux-title/src/index.ts \
  ~/.pi/agent/extensions/tmux-title.ts
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
pi install /absolute/path/to/pi-extensions-lab/packages/tmux-title
```

Project-local install from a project that should use it:

```bash
pi install -l /absolute/path/to/pi-extensions-lab/packages/tmux-title
```

## Command

The extension registers:

```text
/tmux-title
/tmux-title apply
/tmux-title set <title>
/tmux-title reset
/tmux-title restore
```

- `/tmux-title` shows status and the last apply errors, if any.
- `/tmux-title apply` reapplies the configured title.
- `/tmux-title set <title>` temporarily changes the title for the current extension instance.
- `/tmux-title reset` clears the temporary title and reapplies the configured flag value.
- `/tmux-title restore` restores the saved tmux window name and `automatic-rename` value.

## Configuration flags

These are optional startup flags:

```bash
pi -e ./src/index.ts \
  --tmux-title pi \
  --tmux-title-terminal \
  --tmux-title-window \
  --tmux-title-pane \
  --tmux-title-disable-automatic-rename \
  --tmux-title-restore-on-exit
```

| Flag | Default | Meaning |
|---|---:|---|
| `--tmux-title` | `pi` | Title to set. |
| `--tmux-title-terminal` | `true` | Set the terminal title with Pi's UI API. |
| `--tmux-title-window` | `true` | Rename the current tmux window/tab. |
| `--tmux-title-pane` | `true` | Set the current tmux pane title. |
| `--tmux-title-disable-automatic-rename` | `true` | Disable tmux automatic renaming while Pi is running. |
| `--tmux-title-restore-on-exit` | `true` | Restore the saved tmux title state on clean shutdown. |

## Notes

- The tmux-specific commands only run when `TMUX` is present in the environment.
- There can still be a brief startup moment where tmux shows `node` before Pi loads extensions and fires `session_start`.
- If Pi crashes or the process is killed hard, the clean shutdown restore hook may not run. Use `/tmux-title restore` in a later Pi session, or run tmux commands manually.
