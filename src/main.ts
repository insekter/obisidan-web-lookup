import { Notice, Plugin, TAbstractFile } from "obsidian";
import { TokenCache } from "./cache";
import { HoverController } from "./hover";
import { openSearch } from "./search";
import { DEFAULT_SETTINGS, WebLookupSettings, WebLookupSettingTab } from "./settings";

export default class WebLookupPlugin extends Plugin {
	settings!: WebLookupSettings;
	cache!: TokenCache;
	hover!: HoverController;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.cache = new TokenCache(this);
		this.hover = new HoverController(this);

		this.addSettingTab(new WebLookupSettingTab(this.app, this));

		this.addCommand({
			id: "clear-token-cache",
			name: "Clear tokenization caches",
			callback: async () => {
				await this.cache.clearAll();
				new Notice("web-lookup: caches cleared.");
			},
		});

		this.app.workspace.onLayoutReady(() => {
			this.hover.attach(window);
			void this.cache.init();
		});
		// pop-out windows have their own document
		this.registerEvent(this.app.workspace.on("window-open", (_ws, win) => this.hover.attach(win)));

		// keep the disk cache tidy
		const gone = (f: TAbstractFile) => this.cache.forget(f.path);
		this.registerEvent(this.app.vault.on("delete", gone));
		this.registerEvent(this.app.vault.on("rename", (_f, oldPath) => this.cache.forget(oldPath)));
	}

	onunload(): void {
		this.hover?.dispose();
		void this.cache?.shutdown();
	}

	async search(query: string): Promise<void> {
		await openSearch(this, query);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<WebLookupSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.cache.onSettingsChanged();
	}
}
