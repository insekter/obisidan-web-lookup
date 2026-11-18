import { App, Notice, Platform } from "obsidian";
import type WebLookupPlugin from "./main";

export type SearchEngine = "google" | "duckduckgo" | "bing" | "yandex" | "baidu";

export const ENGINES: Record<SearchEngine, { label: string; url: (encodedQuery: string) => string }> = {
	google: { label: "Google", url: (q) => `https://www.google.com/search?q=${q}` },
	duckduckgo: { label: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${q}` },
	bing: { label: "Bing", url: (q) => `https://www.bing.com/search?q=${q}` },
	yandex: { label: "Yandex", url: (q) => `https://yandex.com/search/?text=${q}` },
	baidu: { label: "Baidu", url: (q) => `https://www.baidu.com/s?wd=${q}` },
};

/** True when the Web viewer core plugin exists and is enabled (desktop only). */
export function isWebViewerEnabled(app: App): boolean {
	if (!Platform.isDesktopApp) return false;
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const ip = (app as any).internalPlugins;
		if (ip?.getEnabledPluginById?.("webviewer")) return true;
		return !!ip?.plugins?.["webviewer"]?.enabled;
	} catch {
		return false;
	}
}

export function buildSearchUrl(engine: SearchEngine, query: string): string {
	return ENGINES[engine].url(encodeURIComponent(query));
}

export async function openSearch(plugin: WebLookupPlugin, query: string): Promise<void> {
	const s = plugin.settings;
	const url = buildSearchUrl(s.searchEngine, query);

	if (s.openInBrowser === "webviewer") {
		if (await openInWebViewer(plugin, url)) return;
		new Notice("web-lookup: Web viewer unavailable, opened in the external browser.");
	}
	openExternal(url);
}

/**
 * The Web viewer core plugin has no public API. This relies on its view type id
 * ("webviewer") and its view state ({ url, navigate }). If that ever changes the
 * caller falls back to the external browser.
 */
async function openInWebViewer(plugin: WebLookupPlugin, url: string): Promise<boolean> {
	const { app } = plugin;
	if (!isWebViewerEnabled(app)) return false;

	const fresh = plugin.settings.openInTab === "new-tab";
	const leaf = fresh ? app.workspace.getLeaf("tab") : app.workspace.getLeaf(false);

	try {
		await leaf.setViewState({
			type: "webviewer",
			active: true,
			state: { url, navigate: true },
		});
	} catch (e) {
		console.error("web-lookup: could not open Web viewer", e);
		if (fresh) leaf.detach();
		return false;
	}

	if (leaf.view.getViewType() !== "webviewer") {
		if (fresh) leaf.detach();
		return false;
	}
	await app.workspace.revealLeaf(leaf);
	return true;
}

function openExternal(url: string): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const electron = (window as any).require?.("electron");
		if (electron?.shell?.openExternal) {
			void electron.shell.openExternal(url);
			return;
		}
	} catch {
		/* fall through */
	}
	window.open(url, "_blank");
}
