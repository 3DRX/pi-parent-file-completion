import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SideChatConfig = {
	panel: {
		width: number | `${number}%`;
		height: number | `${number}%`;
		minHeight: number;
		maxHeight: number | `${number}%`;
		margin: number;
		maxTranscriptLines: number;
		maxInputLines: number;
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
		width: "50%",
		height: "100%",
		minHeight: 18,
		maxHeight: "100%",
		margin: 0,
		maxTranscriptLines: 120,
		maxInputLines: 5,
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

const LEGACY_AUTO_POPULATED_CONFIGS: SideChatConfig[] = [
	{
		panel: {
			width: "30%",
			height: "80%",
			minHeight: 18,
			maxHeight: "95%",
			margin: 1,
			maxTranscriptLines: 120,
			maxInputLines: 5,
		},
		session: {
			deleteOnClose: true,
			deleteOnMerge: true,
		},
		merge: {
			requireParentUnchanged: true,
		},
	},
	{
		panel: {
			width: "50%",
			height: "80%",
			minHeight: 18,
			maxHeight: "95%",
			margin: 1,
			maxTranscriptLines: 120,
			maxInputLines: 5,
		},
		session: {
			deleteOnClose: true,
			deleteOnMerge: true,
		},
		merge: {
			requireParentUnchanged: true,
		},
	},
];

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
		next.panel.height = parseDimension(patch.panel.height, next.panel.height);
		next.panel.minHeight = parsePositiveInt(patch.panel.minHeight, next.panel.minHeight);
		next.panel.maxHeight = parseDimension(patch.panel.maxHeight, next.panel.maxHeight);
		next.panel.margin = parseNonNegativeInt(patch.panel.margin, next.panel.margin);
		next.panel.maxTranscriptLines = parsePositiveInt(
			patch.panel.maxTranscriptLines,
			next.panel.maxTranscriptLines,
		);
		next.panel.maxInputLines = parsePositiveInt(patch.panel.maxInputLines, next.panel.maxInputLines);
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

function serializeConfig(config: SideChatConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

function isLegacyAutoPopulatedConfig(value: unknown): boolean {
	const serialized = JSON.stringify(value);
	return LEGACY_AUTO_POPULATED_CONFIGS.some((config) => serialized === JSON.stringify(config));
}

function migrateLegacyAutoPopulatedConfig(value: unknown): unknown {
	if (!isLegacyAutoPopulatedConfig(value)) return value;
	return DEFAULT_CONFIG;
}

function writeConfigIfChanged(path: string, config: SideChatConfig): void {
	const next = serializeConfig(config);
	if (existsSync(path)) {
		const current = readFileSync(path, "utf8");
		if (current === next) return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next, "utf8");
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

	try {
		const data = migrateLegacyAutoPopulatedConfig(readJson(paths.global));
		if (data !== undefined) config = mergeConfig(config, data);

		// Keep the global config explicit. If the file is missing, create it with
		// defaults. If it contains a partial config, write back the normalized
		// default+user merge so users can see every available option.
		writeConfigIfChanged(paths.global, config);
	} catch (error) {
		warnings.push(
			`Failed to load or populate global side-chat config at ${paths.global}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (ctx.isProjectTrusted()) {
		try {
			const data = migrateLegacyAutoPopulatedConfig(readJson(paths.project));
			if (data !== undefined) {
				config = mergeConfig(config, data);
				// Do not auto-create project config files. If a trusted project already
				// has one, normalize it against the effective config so missing fields
				// are visible while preserving global defaults and overrides.
				writeConfigIfChanged(paths.project, config);
			}
		} catch (error) {
			warnings.push(
				`Failed to load or populate project side-chat config at ${paths.project}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return { config, warnings };
}
