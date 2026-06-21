import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SideChatConfig = {
	panel: {
		width: number | `${number}%`;
		maxHeight: number | `${number}%`;
		margin: number;
		maxTranscriptLines: number;
	};
	session: {
		deleteOnClose: boolean;
		deleteOnMerge: boolean;
	};
	merge: {
		requireParentUnchanged: boolean;
	};
};

const DEFAULT_CONFIG: SideChatConfig = {
	panel: {
		width: "30%",
		maxHeight: "95%",
		margin: 1,
		maxTranscriptLines: 120,
	},
	session: {
		deleteOnClose: true,
		deleteOnMerge: true,
	},
	merge: {
		requireParentUnchanged: true,
	},
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDimension(value: unknown, fallback: number | `${number}%`): number | `${number}%` {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	const percentMatch = trimmed.match(/^(\d+(?:\.\d+)?)%$/);
	if (percentMatch) {
		const n = Number(percentMatch[1]);
		if (Number.isFinite(n) && n > 0 && n <= 100) return `${n}%` as `${number}%`;
	}
	const n = Number(trimmed);
	if (Number.isFinite(n) && n > 0) return Math.floor(n);
	return fallback;
}

function parsePositiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.floor(n);
}

function parseNonNegativeInt(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
	if (!Number.isFinite(n) || n < 0) return fallback;
	return Math.floor(n);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(normalized)) return true;
		if (["false", "0", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function mergeConfig(base: SideChatConfig, patch: unknown): SideChatConfig {
	if (!isObject(patch)) return base;

	const next: SideChatConfig = {
		panel: { ...base.panel },
		session: { ...base.session },
		merge: { ...base.merge },
	};

	if (isObject(patch.panel)) {
		next.panel.width = parseDimension(patch.panel.width, next.panel.width);
		next.panel.maxHeight = parseDimension(patch.panel.maxHeight, next.panel.maxHeight);
		next.panel.margin = parseNonNegativeInt(patch.panel.margin, next.panel.margin);
		next.panel.maxTranscriptLines = parsePositiveInt(
			patch.panel.maxTranscriptLines,
			next.panel.maxTranscriptLines,
		);
	}
	if (isObject(patch.session)) {
		next.session.deleteOnClose = parseBoolean(patch.session.deleteOnClose, next.session.deleteOnClose);
		next.session.deleteOnMerge = parseBoolean(patch.session.deleteOnMerge, next.session.deleteOnMerge);
	}
	if (isObject(patch.merge)) {
		next.merge.requireParentUnchanged = parseBoolean(
			patch.merge.requireParentUnchanged,
			next.merge.requireParentUnchanged,
		);
	}

	return next;
}

function readJson(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

export function getConfigPaths(ctx: ExtensionContext): { global: string; project: string } {
	return {
		global: join(getAgentDir(), "pi-extensions-lab", "side-chat.json"),
		project: join(ctx.cwd, CONFIG_DIR_NAME, "pi-extensions-lab", "side-chat.json"),
	};
}

export function loadSideChatConfig(ctx: ExtensionContext): { config: SideChatConfig; warnings: string[] } {
	const paths = getConfigPaths(ctx);
	const warnings: string[] = [];
	let config = DEFAULT_CONFIG;

	for (const [scope, path] of [
		["global", paths.global] as const,
		["project", paths.project] as const,
	]) {
		if (scope === "project" && !ctx.isProjectTrusted()) continue;
		try {
			const data = readJson(path);
			if (data !== undefined) config = mergeConfig(config, data);
		} catch (error) {
			warnings.push(`Failed to load ${scope} side-chat config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { config, warnings };
}
