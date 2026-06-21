import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

type Config = {
	maxResults: number;
	maxDepth: number;
	maxEntries: number;
	cacheMs: number;
	excludes: Set<string>;
};

type Candidate = {
	relativePath: string;
	name: string;
	isDirectory: boolean;
};

type CacheEntry = {
	createdAt: number;
	entries: Candidate[];
	truncated: boolean;
};

const DEFAULT_EXCLUDES = [
	".git",
	".hg",
	".svn",
	"node_modules",
	"dist",
	"build",
	".next",
	".nuxt",
	"coverage",
	".DS_Store",
	// Searching outside cwd can accidentally enter sensitive home-directory
	// locations. Users can override with --parent-completion-exclude.
	".ssh",
	".gnupg",
];

const DEFAULT_CONFIG: Config = {
	maxResults: 30,
	maxDepth: 8,
	maxEntries: 20_000,
	cacheMs: 15_000,
	excludes: new Set(DEFAULT_EXCLUDES),
};

function parsePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value !== "string" && typeof value !== "number") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
}

function parseExcludes(value: unknown): Set<string> {
	if (typeof value !== "string" || value.trim() === "") {
		return new Set(DEFAULT_EXCLUDES);
	}

	return new Set(
		value
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

function getConfig(pi: ExtensionAPI): Config {
	return {
		maxResults: parsePositiveInteger(pi.getFlag("parent-completion-max-results"), DEFAULT_CONFIG.maxResults),
		maxDepth: parsePositiveInteger(pi.getFlag("parent-completion-max-depth"), DEFAULT_CONFIG.maxDepth),
		maxEntries: parsePositiveInteger(pi.getFlag("parent-completion-max-entries"), DEFAULT_CONFIG.maxEntries),
		cacheMs: parsePositiveInteger(pi.getFlag("parent-completion-cache-ms"), DEFAULT_CONFIG.cacheMs),
		excludes: parseExcludes(pi.getFlag("parent-completion-exclude")),
	};
}

function normalizeSlashes(path: string): string {
	return path.replaceAll("\\", "/");
}

function stripClosingQuote(path: string): string {
	return path.endsWith('"') ? path.slice(0, -1) : path;
}

function extractAtPrefix(textBeforeCursor: string): string | null {
	// Matches the token at the cursor when it is an @ file reference:
	//   @../foo
	//   @../../foo
	//   @"../folder with spaces/foo
	//   @"../folder with spaces/foo"
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*"?|[^\s]*))$/);
	return match?.[1] ?? null;
}

function unquoteAtPrefix(prefix: string): string {
	if (prefix.startsWith('@"')) return stripClosingQuote(prefix.slice(2));
	if (prefix.startsWith("@")) return stripClosingQuote(prefix.slice(1));
	return stripClosingQuote(prefix);
}

type ParentReference = {
	/** The user-visible base, such as "../" or "../../sibling/". */
	displayBase: string;
	/** The fuzzy query searched under displayBase. */
	query: string;
};

function parseParentReference(rawPrefixWithoutAt: string): ParentReference | null {
	const raw = normalizeSlashes(rawPrefixWithoutAt);

	// Let typing @.. immediately search the parent directory, without requiring
	// the user to type the slash first. Also supports @../.. and @../../...
	if (raw === ".." || /^(?:\.\.\/)*\.\.$/.test(raw)) {
		return { displayBase: `${raw}/`, query: "" };
	}

	if (!raw.startsWith("../")) return null;

	if (raw.endsWith("/")) {
		return { displayBase: raw, query: "" };
	}

	const slashIndex = raw.lastIndexOf("/");
	if (slashIndex < 0) return null;

	const displayBase = raw.slice(0, slashIndex + 1);
	const query = raw.slice(slashIndex + 1);

	if (!displayBase.startsWith("../")) return null;
	return { displayBase, query };
}

function needsQuotes(path: string): boolean {
	return /\s/.test(path);
}

function buildAtCompletionValue(path: string): string {
	const normalized = normalizeSlashes(path);
	return needsQuotes(normalized) ? `@"${normalized}"` : `@${normalized}`;
}

function sortPathEntries(entries: Candidate[]): Candidate[] {
	return [...entries].sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.relativePath.localeCompare(b.relativePath);
	});
}

function candidateToItem(displayBase: string, candidate: Candidate): AutocompleteItem {
	const completedPath = normalizeSlashes(`${displayBase}${candidate.relativePath}`);
	return {
		value: buildAtCompletionValue(completedPath),
		label: `${candidate.name}${candidate.isDirectory ? "/" : ""}`,
		description: completedPath,
	};
}

async function scanDirectory(
	absoluteBase: string,
	recursive: boolean,
	config: Config,
	signal: AbortSignal,
): Promise<CacheEntry> {
	const entries: Candidate[] = [];
	const queue: Array<{ absoluteDir: string; relativeDir: string; depth: number }> = [
		{ absoluteDir: absoluteBase, relativeDir: "", depth: 0 },
	];

	let scannedEntries = 0;
	let truncated = false;

	while (queue.length > 0) {
		if (signal.aborted) break;
		if (scannedEntries >= config.maxEntries) {
			truncated = true;
			break;
		}

		const next = queue.shift();
		if (!next) break;

		let dirents;
		try {
			dirents = await readdir(next.absoluteDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const dirent of dirents) {
			if (signal.aborted) break;
			if (scannedEntries >= config.maxEntries) {
				truncated = true;
				break;
			}

			scannedEntries += 1;

			if (config.excludes.has(dirent.name)) continue;

			const isDirectory = dirent.isDirectory();
			const relativePath = next.relativeDir ? `${next.relativeDir}/${dirent.name}` : dirent.name;
			entries.push({
				relativePath: `${relativePath}${isDirectory ? "/" : ""}`,
				name: dirent.name,
				isDirectory,
			});

			if (recursive && isDirectory && next.depth < config.maxDepth) {
				queue.push({
					absoluteDir: resolve(next.absoluteDir, dirent.name),
					relativeDir: relativePath,
					depth: next.depth + 1,
				});
			}
		}
	}

	return { createdAt: Date.now(), entries: sortPathEntries(entries), truncated };
}

function filterCandidates(entries: Candidate[], query: string, maxResults: number): Candidate[] {
	if (query.trim() === "") return entries.slice(0, maxResults);
	return fuzzyFilter(entries, query, (entry) => entry.relativePath).slice(0, maxResults);
}

function cacheKey(absoluteBase: string, recursive: boolean): string {
	return `${absoluteBase}\0${recursive ? "recursive" : "immediate"}`;
}

function createParentFileProvider(
	pi: ExtensionAPI,
	current: AutocompleteProvider,
	cwd: string,
	cache: Map<string, CacheEntry>,
): AutocompleteProvider {
	async function getEntries(
		absoluteBase: string,
		recursive: boolean,
		config: Config,
		signal: AbortSignal,
	): Promise<CacheEntry> {
		const key = cacheKey(absoluteBase, recursive);
		const cached = cache.get(key);
		if (cached && Date.now() - cached.createdAt <= config.cacheMs) return cached;

		const scanned = await scanDirectory(absoluteBase, recursive, config, signal);
		if (!signal.aborted) cache.set(key, scanned);
		return scanned;
	}

	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const prefix = extractAtPrefix(textBeforeCursor);

			if (!prefix) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const parsed = parseParentReference(unquoteAtPrefix(prefix));
			if (!parsed) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const config = getConfig(pi);
			const absoluteBase = resolve(cwd, parsed.displayBase);
			const recursive = parsed.query.trim() !== "";
			const entry = await getEntries(absoluteBase, recursive, config, options.signal);
			if (options.signal.aborted) return null;

			const candidates = filterCandidates(entry.entries, parsed.query, config.maxResults);
			if (candidates.length === 0) return null;

			return {
				prefix,
				items: candidates.map((candidate) => candidateToItem(parsed.displayBase, candidate)),
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			// This wrapper delegates most autocomplete to Pi's built-in provider. If
			// the selected suggestion came from that provider (slash commands, normal
			// @file completion, command arguments, etc.), its applyCompletion logic must
			// handle it too. Otherwise slash command completion loses the leading `/`
			// and the editor submits plain text such as "reload" to the agent.
			if (!parseParentReference(unquoteAtPrefix(prefix))) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const adjustedAfterCursor =
				prefix.startsWith('@"') && item.value.endsWith('"') && afterCursor.startsWith('"')
					? afterCursor.slice(1)
					: afterCursor;

			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix}${item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const directoryCursorBeforeClosingQuote = isDirectory && item.value.endsWith('"') ? 1 : 0;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length - directoryCursorBeforeClosingQuote + suffix.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function parentFileCompletion(pi: ExtensionAPI): void {
	pi.registerFlag("parent-completion-max-results", {
		type: "string",
		default: String(DEFAULT_CONFIG.maxResults),
		description: "Maximum @../ autocomplete suggestions to show.",
	});
	pi.registerFlag("parent-completion-max-depth", {
		type: "string",
		default: String(DEFAULT_CONFIG.maxDepth),
		description: "Maximum recursive depth when fuzzy-searching @../ paths.",
	});
	pi.registerFlag("parent-completion-max-entries", {
		type: "string",
		default: String(DEFAULT_CONFIG.maxEntries),
		description: "Maximum filesystem entries to scan per @../ autocomplete base.",
	});
	pi.registerFlag("parent-completion-cache-ms", {
		type: "string",
		default: String(DEFAULT_CONFIG.cacheMs),
		description: "Milliseconds to cache @../ autocomplete scans.",
	});
	pi.registerFlag("parent-completion-exclude", {
		type: "string",
		default: DEFAULT_EXCLUDES.join(","),
		description: "Comma-separated names to exclude from @../ autocomplete scans.",
	});

	const cache = new Map<string, CacheEntry>();

	pi.registerCommand("parent-completion-status", {
		description: "Show status for the @../ parent file completion extension. Use 'clear' to clear cache.",
		handler: async (args, ctx) => {
			if (args.trim() === "clear") {
				cache.clear();
				ctx.ui.notify("parent-file-completion: cache cleared", "info");
				return;
			}

			const config = getConfig(pi);
			const truncatedCount = [...cache.values()].filter((entry) => entry.truncated).length;
			ctx.ui.notify(
				[
					"parent-file-completion is loaded",
					`cache entries: ${cache.size}`,
					`truncated scans: ${truncatedCount}`,
					`max results: ${config.maxResults}`,
					`max depth: ${config.maxDepth}`,
					`max entries: ${config.maxEntries}`,
					`cache ms: ${config.cacheMs}`,
					`excluded names: ${[...config.excludes].join(", ") || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => createParentFileProvider(pi, current, ctx.cwd, cache));
	});

	pi.on("session_shutdown", () => {
		cache.clear();
	});
}
