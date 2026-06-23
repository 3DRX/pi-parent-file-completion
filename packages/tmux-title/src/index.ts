import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Snapshot = {
	windowName: string | null;
	automaticRename: string | null;
};

type ApplyResult = {
	terminalTitleSet: boolean;
	tmuxDetected: boolean;
	windowRenamed: boolean;
	paneTitleSet: boolean;
	automaticRenameDisabled: boolean;
	errors: string[];
};

const DEFAULT_TITLE = "pi";
const TMUX_TIMEOUT_MS = 1_000;

function flagString(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed === "" ? fallback : trimmed;
}

function flagBoolean(pi: ExtensionAPI, name: string, fallback: boolean): boolean {
	const value = pi.getFlag(name);
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return fallback;
	}
}

function isTmux(): boolean {
	return typeof process.env.TMUX === "string" && process.env.TMUX.length > 0;
}

async function tmux(pi: ExtensionAPI, args: string[], ctx: ExtensionContext): Promise<string | null> {
	try {
		const result = await pi.exec("tmux", args, { cwd: ctx.cwd, timeout: TMUX_TIMEOUT_MS });
		if (result.code !== 0) return null;
		return result.stdout.trimEnd();
	} catch {
		return null;
	}
}

async function readSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): Promise<Snapshot> {
	if (!isTmux()) return { windowName: null, automaticRename: null };

	const [windowName, automaticRename] = await Promise.all([
		tmux(pi, ["display-message", "-p", "#W"], ctx),
		tmux(pi, ["show-window-options", "-qv", "automatic-rename"], ctx),
	]);

	return { windowName, automaticRename };
}

async function runTmuxCommand(
	pi: ExtensionAPI,
	args: string[],
	ctx: ExtensionContext,
	errors: string[],
	description: string,
): Promise<boolean> {
	try {
		const result = await pi.exec("tmux", args, { cwd: ctx.cwd, timeout: TMUX_TIMEOUT_MS });
		if (result.code === 0) return true;

		const detail = (result.stderr || result.stdout).trim();
		errors.push(detail ? `${description}: ${detail}` : `${description}: tmux exited ${result.code}`);
		return false;
	} catch (error) {
		errors.push(`${description}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

export default function tmuxTitleExtension(pi: ExtensionAPI): void {
	let snapshot: Snapshot | null = null;
	let runtimeTitle: string | null = null;
	let lastResult: ApplyResult | null = null;
	let notifiedError = false;

	pi.registerFlag("tmux-title", {
		type: "string",
		default: DEFAULT_TITLE,
		description: "Terminal/tmux title to set when Pi starts.",
	});
	pi.registerFlag("tmux-title-terminal", {
		type: "boolean",
		default: true,
		description: "Set the terminal title with ctx.ui.setTitle().",
	});
	pi.registerFlag("tmux-title-window", {
		type: "boolean",
		default: true,
		description: "Rename the current tmux window/tab.",
	});
	pi.registerFlag("tmux-title-pane", {
		type: "boolean",
		default: true,
		description: "Set the current tmux pane title too.",
	});
	pi.registerFlag("tmux-title-disable-automatic-rename", {
		type: "boolean",
		default: true,
		description: "Disable tmux automatic-rename for the current window so tmux does not switch back to 'node'.",
	});
	pi.registerFlag("tmux-title-restore-on-exit", {
		type: "boolean",
		default: true,
		description: "Restore the previous tmux window name and automatic-rename value when the Pi session shuts down.",
	});

	function configuredTitle(): string {
		return runtimeTitle ?? flagString(pi, "tmux-title", DEFAULT_TITLE);
	}

	async function applyTitle(ctx: ExtensionContext, title = configuredTitle()): Promise<ApplyResult> {
		const result: ApplyResult = {
			terminalTitleSet: false,
			tmuxDetected: isTmux(),
			windowRenamed: false,
			paneTitleSet: false,
			automaticRenameDisabled: false,
			errors: [],
		};

		if (flagBoolean(pi, "tmux-title-terminal", true) && ctx.hasUI) {
			ctx.ui.setTitle(title);
			result.terminalTitleSet = true;
		}

		if (!result.tmuxDetected) {
			lastResult = result;
			return result;
		}

		if (!snapshot) snapshot = await readSnapshot(pi, ctx);

		if (flagBoolean(pi, "tmux-title-disable-automatic-rename", true)) {
			result.automaticRenameDisabled = await runTmuxCommand(
				pi,
				["set-window-option", "automatic-rename", "off"],
				ctx,
				result.errors,
				"disable automatic-rename",
			);
		}

		if (flagBoolean(pi, "tmux-title-window", true)) {
			result.windowRenamed = await runTmuxCommand(
				pi,
				["rename-window", title],
				ctx,
				result.errors,
				"rename window",
			);
		}

		if (flagBoolean(pi, "tmux-title-pane", true)) {
			result.paneTitleSet = await runTmuxCommand(
				pi,
				["select-pane", "-T", title],
				ctx,
				result.errors,
				"set pane title",
			);
		}

		lastResult = result;
		return result;
	}

	async function restoreTmux(ctx: ExtensionContext): Promise<void> {
		if (!snapshot || !isTmux()) return;

		const errors: string[] = [];
		if (snapshot.automaticRename !== null) {
			await runTmuxCommand(
				pi,
				["set-window-option", "automatic-rename", snapshot.automaticRename],
				ctx,
				errors,
				"restore automatic-rename",
			);
		}
		if (snapshot.windowName !== null) {
			await runTmuxCommand(pi, ["rename-window", snapshot.windowName], ctx, errors, "restore window name");
		}
	}

	pi.registerCommand("tmux-title", {
		description: "Show or update tmux/terminal title. Usage: /tmux-title [status|apply|set <title>|reset|restore]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command = "status", ...rest] = trimmed.split(/\s+/);

			if (command === "apply") {
				const result = await applyTitle(ctx);
				ctx.ui.notify(
					result.errors.length === 0 ? `tmux-title: applied '${configuredTitle()}'` : result.errors.join("\n"),
					result.errors.length === 0 ? "info" : "warning",
				);
				return;
			}

			if (command === "set") {
				const title = rest.join(" ").trim();
				if (!title) {
					ctx.ui.notify("Usage: /tmux-title set <title>", "warning");
					return;
				}
				runtimeTitle = title;
				const result = await applyTitle(ctx, title);
				ctx.ui.notify(
					result.errors.length === 0 ? `tmux-title: set '${title}'` : result.errors.join("\n"),
					result.errors.length === 0 ? "info" : "warning",
				);
				return;
			}

			if (command === "reset") {
				runtimeTitle = null;
				const result = await applyTitle(ctx);
				ctx.ui.notify(
					result.errors.length === 0 ? `tmux-title: reset to '${configuredTitle()}'` : result.errors.join("\n"),
					result.errors.length === 0 ? "info" : "warning",
				);
				return;
			}

			if (command === "restore") {
				await restoreTmux(ctx);
				snapshot = null;
				ctx.ui.notify("tmux-title: restored saved tmux title state", "info");
				return;
			}

			const result = lastResult;
			ctx.ui.notify(
				[
					`tmux-title configured title: ${configuredTitle()}`,
					`inside tmux: ${isTmux() ? "yes" : "no"}`,
					`terminal title: ${flagBoolean(pi, "tmux-title-terminal", true) ? "enabled" : "disabled"}`,
					`tmux window rename: ${flagBoolean(pi, "tmux-title-window", true) ? "enabled" : "disabled"}`,
					`tmux pane title: ${flagBoolean(pi, "tmux-title-pane", true) ? "enabled" : "disabled"}`,
					`disable automatic-rename: ${
						flagBoolean(pi, "tmux-title-disable-automatic-rename", true) ? "enabled" : "disabled"
					}`,
					`restore on exit: ${flagBoolean(pi, "tmux-title-restore-on-exit", true) ? "enabled" : "disabled"}`,
					`saved window name: ${snapshot?.windowName ?? "none"}`,
					`saved automatic-rename: ${snapshot?.automaticRename ?? "none"}`,
					...(result?.errors.length ? [`last errors:\n${result.errors.join("\n")}`] : []),
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const result = await applyTitle(ctx);
		if (result.errors.length > 0 && !notifiedError) {
			notifiedError = true;
			ctx.ui.notify(`tmux-title: ${result.errors.join("\n")}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!flagBoolean(pi, "tmux-title-restore-on-exit", true)) return;
		await restoreTmux(ctx);
	});
}
