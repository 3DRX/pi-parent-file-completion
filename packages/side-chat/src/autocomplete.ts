import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";

export const SIDE_CHAT_AUTOCOMPLETE_EVENT = "@3drx/pi-side-chat:autocomplete-provider";

export type SideChatAutocompleteEvent = {
	cwd: string;
	wrap: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => void;
};

const LOCAL_COMMANDS: SlashCommand[] = [
	{
		name: "help",
		description: "Show local side-chat commands",
	},
	{
		name: "merge",
		description: "Merge this side chat into the parent session and close",
	},
	{
		name: "close",
		description: "Close and delete the side-chat session",
	},
	{
		name: "close!",
		description: "Force close when side effects were detected",
	},
	{
		name: "abort",
		description: "Abort the current side response",
	},
	{
		name: "bottom",
		description: "Jump to latest transcript content",
	},
];

async function resolveFdPath(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | null> {
	try {
		const result = await pi.exec("sh", ["-lc", "command -v fd || command -v fdfind || true"], {
			cwd: ctx.cwd,
			timeout: 1_000,
		});
		if (result.code !== 0) return null;
		const path = result.stdout.trim().split("\n")[0]?.trim();
		return path || null;
	} catch {
		return null;
	}
}

export async function createSideChatAutocompleteProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<AutocompleteProvider> {
	let provider: AutocompleteProvider = new CombinedAutocompleteProvider(LOCAL_COMMANDS, ctx.cwd, await resolveFdPath(pi, ctx));
	provider.triggerCharacters = ["@"]; // Slash commands trigger separately in Editor; @ should open file completion naturally.
	const wrappers: Array<(current: AutocompleteProvider) => AutocompleteProvider> = [];

	pi.events.emit(SIDE_CHAT_AUTOCOMPLETE_EVENT, {
		cwd: ctx.cwd,
		wrap: (factory) => wrappers.push(factory),
	} satisfies SideChatAutocompleteEvent);

	const triggerCharacters: string[] = [...(provider.triggerCharacters ?? [])];
	for (const wrapProvider of wrappers) {
		provider = wrapProvider(provider);
		triggerCharacters.push(...(provider.triggerCharacters ?? []));
	}
	provider.triggerCharacters = [...new Set(triggerCharacters)];

	return provider;
}
