import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type WebLookupPlugin from "./main";
import type {
	CaseMode,
	DelimiterMode,
	NormalizationMode,
	PunctuationMode,
} from "./tokenizer";
import { ENGINES, isWebViewerEnabled, type SearchEngine } from "./search";

export type Modifier = "ctrl" | "alt" | "shift" | "meta";

export interface WebLookupSettings {
	// --- open in ---------------------------------------------------------
	openInBrowser: "webviewer" | "external";
	openInTab: "new-tab" | "current-tab";
	searchEngine: SearchEngine;
	modifier: Modifier;
	ignoreLinks: boolean;

	// --- tokenization ----------------------------------------------------
	delimiterMode: DelimiterMode;
	customDelimiters: string;
	language: string;
	punctuation: PunctuationMode;
	caseMode: CaseMode;
	normalization: NormalizationMode;

	// --- permanent cache -------------------------------------------------
	permanentFiletypes: string[];
	permanentDirectories: string[];
	mtimeThresholdDays: number;
	tokenCountThreshold: number;
	lazyLoading: boolean;

	// --- RAM cache -------------------------------------------------------
	slidingWindow: boolean;
	windowSize: number;
}

export const DEFAULT_SETTINGS: WebLookupSettings = {
	openInBrowser: "external",
	openInTab: "new-tab",
	searchEngine: "google",
	modifier: "ctrl",
	ignoreLinks: true,

	delimiterMode: "unicode",
	customDelimiters: "",
	language: "",
	punctuation: "inner",
	caseMode: "preserve",
	normalization: "NFC",

	permanentFiletypes: ["pdf"],
	permanentDirectories: [],
	mtimeThresholdDays: 0,
	tokenCountThreshold: 0,
	lazyLoading: true,

	slidingWindow: true,
	windowSize: 256,
};

function parseList(raw: string, sep: RegExp): string[] {
	return raw
		.split(sep)
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseNonNegInt(raw: string, fallback: number): number {
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class WebLookupSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: WebLookupPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		const save = async () => {
			await this.plugin.saveSettings();
		};

		// ================================================================
		new Setting(containerEl).setName("Search").setHeading();

		new Setting(containerEl)
			.setName("Modifier key")
			.setDesc("Hold this key, hover a word, then left-click to search it.")
			.addDropdown((d) =>
				d
					.addOptions({ ctrl: "Ctrl", alt: "Alt / Option", shift: "Shift", meta: "Cmd / Win" })
					.setValue(s.modifier)
					.onChange(async (v) => {
						s.modifier = v as Modifier;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Let Obsidian handle links")
			.setDesc("Ctrl+click on a link keeps its normal behavior instead of searching its text.")
			.addToggle((t) =>
				t.setValue(s.ignoreLinks).onChange(async (v) => {
					s.ignoreLinks = v;
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Search engine")
			.addDropdown((d) => {
				const opts: Record<string, string> = {};
				for (const [k, e] of Object.entries(ENGINES)) opts[k] = e.label;
				d.addOptions(opts)
					.setValue(s.searchEngine)
					.onChange(async (v) => {
						s.searchEngine = v as SearchEngine;
						await save();
					});
			});

		const wvOk = isWebViewerEnabled(this.app);
		new Setting(containerEl)
			.setName("Open in browser")
			.setDesc(
				"External uses your system browser. Built-in uses the Web viewer core plugin" +
				(wvOk ? "." : " (currently disabled or unavailable; the external browser will be used instead).")
			)
			.addDropdown((d) =>
				d
					.addOptions({ external: "External browser", webviewer: "Built-in Web viewer" })
					.setValue(s.openInBrowser)
					.onChange(async (v) => {
						s.openInBrowser = v as WebLookupSettings["openInBrowser"];
						await save();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Open in tab")
			.setDesc("Only applies to the built-in Web viewer.")
			.addDropdown((d) =>
				d
					.addOptions({ "new-tab": "New tab", "current-tab": "Current tab" })
					.setValue(s.openInTab)
					.setDisabled(s.openInBrowser === "external")
					.onChange(async (v) => {
						s.openInTab = v as WebLookupSettings["openInTab"];
						await save();
					})
			);

		// ================================================================
		new Setting(containerEl).setName("Tokenization").setHeading();

		new Setting(containerEl)
			.setName("Delimiters")
			.setDesc(
				"Unicode: language-aware word boundaries (also splits Chinese, Japanese, Thai). " +
				"Whitespace: split on whitespace only. Custom: whitespace plus the characters you list."
			)
			.addDropdown((d) =>
				d
					.addOptions({
						unicode: "Unicode word boundaries",
						whitespace: "Whitespace only",
						custom: "Custom characters",
					})
					.setValue(s.delimiterMode)
					.onChange(async (v) => {
						s.delimiterMode = v as DelimiterMode;
						await save();
						this.display();
					})
			);

		if (s.delimiterMode === "custom") {
			new Setting(containerEl)
				.setName("Custom delimiter characters")
				.setDesc("Every character typed here separates tokens, e.g. ,;/|")
				.addText((t) =>
					t.setValue(s.customDelimiters).onChange(async (v) => {
						s.customDelimiters = v;
						await save();
					})
				);
		}

		if (s.delimiterMode === "unicode") {
			new Setting(containerEl)
				.setName("Language")
				.setDesc("Optional BCP 47 tag (e.g. ja, zh-Hans, th) that tunes word segmentation. Empty = default.")
				.addText((t) =>
					t
						.setPlaceholder("auto")
						.setValue(s.language)
						.onChange(async (v) => {
							s.language = v.trim();
							await save();
						})
				);
		}

		new Setting(containerEl)
			.setName("Punctuation handling")
			.setDesc(
				"Split: punctuation always separates tokens. " +
				"Keep inside words: don't, well-known stay whole, edge punctuation is dropped. " +
				"Keep all: punctuation stays attached to the word."
			)
			.addDropdown((d) =>
				d
					.addOptions({ strip: "Split", inner: "Keep inside words", keep: "Keep all" })
					.setValue(s.punctuation)
					.onChange(async (v) => {
						s.punctuation = v as PunctuationMode;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Case sensitivity")
			.setDesc("Applied to the search string only.")
			.addDropdown((d) =>
				d
					.addOptions({
						preserve: "Case-sensitive (keep as written)",
						lowercase: "Case-insensitive (lowercase)",
						uppercase: "Case-insensitive (UPPERCASE)",
					})
					.setValue(s.caseMode)
					.onChange(async (v) => {
						s.caseMode = v as CaseMode;
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Normalization")
			.setDesc("Unicode normalization applied to the search string.")
			.addDropdown((d) =>
				d
					.addOptions({
						none: "None",
						NFC: "NFC (composed)",
						NFD: "NFD (decomposed)",
						NFKC: "NFKC (compatibility, composed)",
						NFKD: "NFKD (compatibility, decomposed)",
						"strip-diacritics": "Strip diacritics (é → e)",
					})
					.setValue(s.normalization)
					.onChange(async (v) => {
						s.normalization = v as NormalizationMode;
						await save();
					})
			);

		// ================================================================
		new Setting(containerEl).setName("Permanent cache (disk)").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Token boundaries are cached per file as you hover. A file's cache is written to disk when it matches " +
				"an always-rule below, or when it satisfies every threshold that is set (greater than 0).",
		});

		new Setting(containerEl)
			.setName("Always cache file types")
			.setDesc("Comma-separated extensions, e.g. pdf, md")
			.addText((t) =>
				t
					.setPlaceholder("pdf")
					.setValue(s.permanentFiletypes.join(", "))
					.onChange(async (v) => {
						s.permanentFiletypes = parseList(v.toLowerCase().replace(/\./g, ""), /[,\s]+/);
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Always cache directories")
			.setDesc("One vault-relative folder per line. Subfolders are included.")
			.addTextArea((t) =>
				t
					.setPlaceholder("Library/Papers")
					.setValue(s.permanentDirectories.join("\n"))
					.onChange(async (v) => {
						s.permanentDirectories = parseList(v, /\n+/).map((d) => d.replace(/^\/+|\/+$/g, ""));
						await save();
					})
			);

		new Setting(containerEl)
			.setName("Modified-time threshold (days)")
			.setDesc("Only cache files not modified for at least this many days. 0 = ignore this rule.")
			.addText((t) =>
				t.setValue(String(s.mtimeThresholdDays)).onChange(async (v) => {
					s.mtimeThresholdDays = parseNonNegInt(v, s.mtimeThresholdDays);
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Token-count threshold")
			.setDesc("Only cache files whose cached token count has reached this number. 0 = ignore this rule.")
			.addText((t) =>
				t.setValue(String(s.tokenCountThreshold)).onChange(async (v) => {
					s.tokenCountThreshold = parseNonNegInt(v, s.tokenCountThreshold);
					await save();
				})
			);

		new Setting(containerEl)
			.setName("Lazy loading")
			.setDesc(
				"Yes: a file's cache is read from disk the first time you use that file. " +
				"No: every cache file is loaded into memory when Obsidian starts."
			)
			.addToggle((t) =>
				t.setValue(s.lazyLoading).onChange(async (v) => {
					s.lazyLoading = v;
					await save();
				})
			);

		// ================================================================
		new Setting(containerEl).setName("Memory cache (RAM)").setHeading();

		new Setting(containerEl)
			.setName("Sliding window")
			.setDesc(
				"Yes: keep only the most recently used blocks (paragraphs, lines, PDF pages) of each file in memory. " +
				"No: keep everything until the global memory limit is reached."
			)
			.addToggle((t) =>
				t.setValue(s.slidingWindow).onChange(async (v) => {
					s.slidingWindow = v;
					await save();
					this.display();
				})
			);

		if (s.slidingWindow) {
			new Setting(containerEl)
				.setName("Window size (blocks per file)")
				.addText((t) =>
					t.setValue(String(s.windowSize)).onChange(async (v) => {
						s.windowSize = Math.max(8, parseNonNegInt(v, s.windowSize));
						await save();
					})
				);
		}

		// ================================================================
		new Setting(containerEl).setName("Maintenance").setHeading();

		const statsSetting = new Setting(containerEl).setName("Cache status").setDesc("Loading…");
		const refresh = async () => {
			const st = await this.plugin.cache.getStats();
			statsSetting.setDesc(
				`Memory: ${st.ramFiles} files, ${st.ramBlocks} blocks, ${st.ramTokens} tokens. ` +
				`Disk: ${st.diskFiles} files, ${fmtBytes(st.diskBytes)}.`
			);
		};
		void refresh();
		statsSetting
			.addButton((b) => b.setButtonText("Refresh").onClick(() => void refresh()))
			.addButton((b) =>
				b
					.setButtonText("Clear all caches")
					.setWarning()
					.onClick(async () => {
						await this.plugin.cache.clearAll();
						new Notice("web-lookup: caches cleared.");
						await refresh();
					})
			);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: "Modifier key", desc: "Hold this key while hovering to search", aliases: ["ctrl", "alt", "shift", "meta"], control: { type: "dropdown", key: "modifier", options: { ctrl: "Ctrl", alt: "Alt / Option", shift: "Shift", meta: "Cmd / Win" } } },
			{ name: "Let Obsidian handle links", desc: "Keep normal link behavior", control: { type: "toggle", key: "ignoreLinks" } },
			{ name: "Search engine", desc: "Choose the web search provider", control: { type: "dropdown", key: "searchEngine", options: { google: "Google", duckduckgo: "DuckDuckGo", bing: "Bing", yandex: "Yandex", baidu: "Baidu" } } },
			{ name: "Open in browser", desc: "External browser or built-in Web viewer", control: { type: "dropdown", key: "openInBrowser", options: { external: "External browser", webviewer: "Built-in Web viewer" } } },
			{ name: "Open in tab", desc: "New tab or current tab", control: { type: "dropdown", key: "openInTab", options: { "new-tab": "New tab", "current-tab": "Current tab" } } },
			{ name: "Delimiters", desc: "Unicode, whitespace, or custom token delimiters", control: { type: "dropdown", key: "delimiterMode", options: { unicode: "Unicode word boundaries", whitespace: "Whitespace only", custom: "Custom characters" } } },
			{ name: "Custom delimiter characters", desc: "Characters that separate tokens", control: { type: "text", key: "customDelimiters", placeholder: ",;/|" } },
			{ name: "Language", desc: "Optional BCP 47 segmentation language", control: { type: "text", key: "language", placeholder: "auto" } },
			{ name: "Punctuation handling", desc: "Split or preserve punctuation", control: { type: "dropdown", key: "punctuation", options: { strip: "Split", inner: "Keep inside words", keep: "Keep all" } } },
			{ name: "Case sensitivity", desc: "Case handling for search queries", control: { type: "dropdown", key: "caseMode", options: { preserve: "Case-sensitive", lowercase: "Lowercase", uppercase: "UPPERCASE" } } },
			{ name: "Normalization", desc: "Unicode normalization for search queries", control: { type: "dropdown", key: "normalization", options: { none: "None", NFC: "NFC", NFD: "NFD", NFKC: "NFKC", NFKD: "NFKD", "strip-diacritics": "Strip diacritics" } } },
			{ name: "Lazy loading", desc: "Load permanent caches on first use", control: { type: "toggle", key: "lazyLoading" } },
			{ name: "Sliding window", desc: "Keep only recent blocks in memory", control: { type: "toggle", key: "slidingWindow" } },
			{ name: "Window size", desc: "Blocks per file in the memory cache", control: { type: "text", key: "windowSize", placeholder: "256" } },
		];
	}
}
