import { TFile } from "obsidian";
import type WebLookupPlugin from "./main";
import { tokenize, tokenizerSignature } from "./tokenizer";

/**
 * Token cache.
 *
 * Unit of caching is a "block": a paragraph / editor line / PDF page, identified by a
 * hash of its text (content-addressed, so a changed block can never return stale
 * tokens). Blocks are grouped per vault file.
 *
 *   RAM  : Map<path, FileCache>; each FileCache keeps blocks in recency order.
 *          - Sliding window ON : each file keeps only its N most recently used blocks.
 *          - Sliding window OFF: unbounded per file, but a global token limit evicts
 *                                least-recently-used files.
 *   Disk : one JSON per file in <plugin dir>/cache/, written (debounced) only when the
 *          persistence policy says so. Stored in recency order, oldest first.
 *          Validated against the file's mtime + size and the tokenizer signature.
 */

const DISK_VERSION = 1;
const MAX_RAM_TOKENS = 1_000_000;
const MAX_DISK_BLOCKS = 50_000;
const ANON_BLOCKS = 128;
const FLUSH_DELAY_MS = 4000;

interface FileCache {
	path: string;
	file: TFile | null;
	mtime: number;
	size: number;
	blocks: Map<string, Uint32Array>;
	dirty: Set<string>;
	tokens: number;
	load: "none" | "loading" | "loaded";
}

interface DiskCache {
	v: number;
	path: string;
	mtime: number;
	size: number;
	sig: string;
	blocks: [string, number[]][];
}

export interface CacheStats {
	ramFiles: number;
	ramBlocks: number;
	ramTokens: number;
	diskFiles: number;
	diskBytes: number;
}

function cyrb53(str: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function blockKey(text: string): string {
	return `${text.length.toString(36)}-${cyrb53(text).toString(36)}`;
}

export class TokenCache {
	private files = new Map<string, FileCache>();
	private anon: FileCache = this.makeFileCache("", null);
	private diskNames = new Set<string>();
	private totalTokens = 0;
	private sig: string;
	private flushTimer: number | null = null;
	private flushQueue = new Set<FileCache>();
	private io: Promise<unknown> = Promise.resolve();
	private preloaded = false;

	constructor(private plugin: WebLookupPlugin) {
		this.sig = tokenizerSignature(plugin.settings);
	}

	// ------------------------------------------------------------------ setup

	async init(): Promise<void> {
		try {
			const dir = this.cacheDir();
			if (await this.adapter.exists(dir)) {
				const listing = await this.adapter.list(dir);
				for (const f of listing.files) {
					const name = f.split("/").pop() ?? f;
					if (name.endsWith(".json")) this.diskNames.add(name);
				}
			}
		} catch (e) {
			console.warn("web-lookup: could not list cache directory", e);
		}
		if (!this.plugin.settings.lazyLoading) void this.preloadAll();
	}

	/** Flush pending writes now (called on unload; best effort). */
	async shutdown(): Promise<void> {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flushAll();
	}

	onSettingsChanged(): void {
		const sig = tokenizerSignature(this.plugin.settings);
		if (sig !== this.sig) {
			this.sig = sig;
			void this.clearAll();
			return;
		}
		for (const fc of this.files.values()) this.trim(fc);
		if (!this.plugin.settings.lazyLoading && !this.preloaded) void this.preloadAll();
	}

	// ------------------------------------------------------------- public API

	/** Synchronous: tokens for `text`, using the cache when possible. */
	getTokens(file: TFile | null, text: string): Uint32Array {
		const fc = file ? this.fileCache(file) : this.anon;
		const key = blockKey(text);
		const hit = fc.blocks.get(key);
		if (hit) {
			fc.blocks.delete(key); // refresh recency
			fc.blocks.set(key, hit);
			return hit;
		}
		const tokens = tokenize(text, this.plugin.settings);
		this.put(fc, key, tokens);
		return tokens;
	}

	forget(path: string): void {
		const fc = this.files.get(path);
		if (fc) this.dropFile(fc);
		this.flushQueue.forEach((q) => q.path === path && this.flushQueue.delete(q));
		const name = this.nameFor(path);
		if (this.diskNames.has(name)) {
			this.diskNames.delete(name);
			void this.enqueue(async () => {
				try {
					await this.adapter.remove(`${this.cacheDir()}/${name}`);
				} catch {
					/* already gone */
				}
			});
		}
	}

	async clearAll(): Promise<void> {
		this.files.clear();
		this.anon = this.makeFileCache("", null);
		this.totalTokens = 0;
		this.flushQueue.clear();
		const names = [...this.diskNames];
		this.diskNames.clear();
		await this.enqueue(async () => {
			for (const n of names) {
				try {
					await this.adapter.remove(`${this.cacheDir()}/${n}`);
				} catch {
					/* ignore */
				}
			}
		});
	}

	async getStats(): Promise<CacheStats> {
		let ramBlocks = 0;
		for (const fc of this.files.values()) ramBlocks += fc.blocks.size;
		let diskBytes = 0;
		for (const n of this.diskNames) {
			try {
				const st = await this.adapter.stat(`${this.cacheDir()}/${n}`);
				diskBytes += st?.size ?? 0;
			} catch {
				/* ignore */
			}
		}
		return {
			ramFiles: this.files.size,
			ramBlocks,
			ramTokens: this.totalTokens,
			diskFiles: this.diskNames.size,
			diskBytes,
		};
	}

	// -------------------------------------------------------------- RAM layer

	private get adapter() {
		return this.plugin.app.vault.adapter;
	}

	private makeFileCache(path: string, file: TFile | null): FileCache {
		return {
			path,
			file,
			mtime: file?.stat.mtime ?? 0,
			size: file?.stat.size ?? 0,
			blocks: new Map(),
			dirty: new Set(),
			tokens: 0,
			load: "loaded",
		};
	}

	private fileCache(file: TFile): FileCache {
		let fc = this.files.get(file.path);
		if (fc && (fc.mtime !== file.stat.mtime || fc.size !== file.stat.size)) {
			// file changed on disk: everything cached for it is stale
			this.dropFile(fc);
			fc = undefined;
		}
		if (!fc) {
			fc = this.makeFileCache(file.path, file);
			fc.load = "none";
			this.files.set(file.path, fc);
		} else {
			this.files.delete(file.path); // LRU touch
			this.files.set(file.path, fc);
		}
		if (fc.load === "none") {
			if (this.diskNames.has(this.nameFor(file.path))) void this.loadFromDisk(fc);
			else fc.load = "loaded";
		}
		return fc;
	}

	private dropFile(fc: FileCache): void {
		if (this.files.get(fc.path) === fc) {
			this.files.delete(fc.path);
			this.totalTokens -= fc.tokens;
		}
	}

	private put(fc: FileCache, key: string, tokens: Uint32Array): void {
		const n = tokens.length / 2;
		fc.blocks.set(key, tokens);
		fc.tokens += n;
		this.totalTokens += n;
		if (fc !== this.anon) {
			fc.dirty.add(key);
			this.queueFlush(fc);
		}
		this.trim(fc);
		this.enforceGlobalLimit(fc);
	}

	private removeBlock(fc: FileCache, key: string): void {
		const t = fc.blocks.get(key);
		if (t) {
			fc.tokens -= t.length / 2;
			this.totalTokens -= t.length / 2;
		}
		fc.blocks.delete(key);
		// NOTE: a block evicted before it was flushed is simply never persisted.
		fc.dirty.delete(key);
	}

	private trim(fc: FileCache): void {
		const s = this.plugin.settings;
		const limit = fc === this.anon ? ANON_BLOCKS : s.slidingWindow ? Math.max(8, s.windowSize) : Infinity;
		while (fc.blocks.size > limit) {
			const oldest = fc.blocks.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.removeBlock(fc, oldest);
		}
	}

	private enforceGlobalLimit(current: FileCache): void {
		while (this.totalTokens > MAX_RAM_TOKENS) {
			const oldestPath = this.files.keys().next().value as string | undefined;
			if (oldestPath === undefined) break;
			const victim = this.files.get(oldestPath);
			if (!victim) break;
			if (victim === current && this.files.size === 1) {
				// single huge file: shed its oldest blocks instead
				const k = victim.blocks.keys().next().value as string | undefined;
				if (k === undefined) break;
				this.removeBlock(victim, k);
				continue;
			}
			if (victim.dirty.size > 0) void this.flushFile(victim);
			this.dropFile(victim);
		}
	}

	// ------------------------------------------------------------- disk layer

	private cacheDir(): string {
		const base =
			this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		return `${base}/cache`;
	}

	private nameFor(path: string): string {
		return `${cyrb53(path).toString(36)}.json`;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.io.then(fn, fn);
		this.io = run.catch(() => undefined);
		return run;
	}

	private async readRaw(name: string): Promise<DiskCache | null> {
		const p = `${this.cacheDir()}/${name}`;
		try {
			if (!(await this.adapter.exists(p))) {
				this.diskNames.delete(name);
				return null;
			}
			const d = JSON.parse(await this.adapter.read(p)) as DiskCache;
			if (d.v !== DISK_VERSION || !Array.isArray(d.blocks)) return null;
			return d;
		} catch (e) {
			console.warn("web-lookup: unreadable cache file", name, e);
			return null;
		}
	}

	private isValid(d: DiskCache, file: TFile): boolean {
		return d.path === file.path && d.sig === this.sig && d.mtime === file.stat.mtime && d.size === file.stat.size;
	}

	private async removeDisk(name: string): Promise<void> {
		this.diskNames.delete(name);
		try {
			await this.adapter.remove(`${this.cacheDir()}/${name}`);
		} catch {
			/* ignore */
		}
	}

	/** Disk -> RAM for one file. Disk data is older than anything already in RAM. */
	private async loadFromDisk(fc: FileCache): Promise<void> {
		fc.load = "loading";
		const file = fc.file;
		if (!file) {
			fc.load = "loaded";
			return;
		}
		const name = this.nameFor(fc.path);
		const disk = await this.enqueue(async () => {
			const d = await this.readRaw(name);
			if (d && !this.isValid(d, file)) {
				await this.removeDisk(name);
				return null;
			}
			return d;
		});
		if (disk && this.files.get(fc.path) === fc) this.mergeFromDisk(fc, disk);
		fc.load = "loaded";
	}

	private mergeFromDisk(fc: FileCache, disk: DiskCache): void {
		const merged = new Map<string, Uint32Array>();
		for (const [k, arr] of disk.blocks) merged.set(k, Uint32Array.from(arr));
		let added = 0;
		for (const [k, v] of merged) if (!fc.blocks.has(k)) added += v.length / 2;
		for (const [k, v] of fc.blocks) {
			merged.delete(k);
			merged.set(k, v); // RAM entries are newer
		}
		fc.blocks = merged;
		fc.tokens += added;
		this.totalTokens += added;
		this.trim(fc);
		this.enforceGlobalLimit(fc);
	}

	/** Eager mode: load every valid cache file into RAM. */
	private async preloadAll(): Promise<void> {
		this.preloaded = true;
		for (const name of [...this.diskNames]) {
			if (this.totalTokens >= MAX_RAM_TOKENS) break;
			const d = await this.enqueue(() => this.readRaw(name));
			if (!d) continue;
			const f = this.plugin.app.vault.getAbstractFileByPath(d.path);
			if (!(f instanceof TFile) || !this.isValid(d, f)) {
				await this.enqueue(() => this.removeDisk(name));
				continue;
			}
			if (this.files.has(f.path)) continue;
			const fc = this.makeFileCache(f.path, f);
			this.files.set(f.path, fc);
			this.mergeFromDisk(fc, d);
		}
	}

	// ----------------------------------------------------------- persistence

	private shouldPersist(file: TFile, tokenCount: number): boolean {
		const s = this.plugin.settings;
		const ext = file.extension.toLowerCase();
		if (s.permanentFiletypes.includes(ext)) return true;
		for (const dir of s.permanentDirectories) {
			if (dir === "" || file.path === dir || file.path.startsWith(`${dir}/`)) return true;
		}
		const useAge = s.mtimeThresholdDays > 0;
		const useCount = s.tokenCountThreshold > 0;
		if (!useAge && !useCount) return false;
		if (useAge && Date.now() - file.stat.mtime < s.mtimeThresholdDays * 86_400_000) return false;
		if (useCount && tokenCount < s.tokenCountThreshold) return false;
		return true;
	}

	private queueFlush(fc: FileCache): void {
		this.flushQueue.add(fc);
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flushAll();
		}, FLUSH_DELAY_MS);
	}

	private async flushAll(): Promise<void> {
		const queue = [...this.flushQueue];
		this.flushQueue.clear();
		for (const fc of queue) await this.flushFile(fc);
	}

	private async flushFile(fc: FileCache): Promise<void> {
		const file = fc.file;
		if (!file || fc.dirty.size === 0) return;
		const keys = [...fc.dirty];
		const fresh = new Map<string, number[]>();
		for (const k of keys) {
			const t = fc.blocks.get(k);
			if (t) fresh.set(k, Array.from(t));
		}
		if (fresh.size === 0) return;

		await this.enqueue(async () => {
			// file modified since this cache was filled -> it describes an old version
			if (file.stat.mtime !== fc.mtime || file.stat.size !== fc.size) return;

			const name = this.nameFor(fc.path);
			let disk = await this.readRaw(name);
			if (disk && !this.isValid(disk, file)) disk = null;

			const merged = new Map<string, number[]>(disk ? disk.blocks : []);
			for (const [k, arr] of fresh) {
				merged.delete(k);
				merged.set(k, arr);
			}
			let count = 0;
			for (const arr of merged.values()) count += arr.length / 2;
			if (!this.shouldPersist(file, count)) return; // stays dirty; retried when more is cached

			while (merged.size > MAX_DISK_BLOCKS) {
				const oldest = merged.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				merged.delete(oldest);
			}

			const dir = this.cacheDir();
			if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
			const payload: DiskCache = {
				v: DISK_VERSION,
				path: fc.path,
				mtime: file.stat.mtime,
				size: file.stat.size,
				sig: this.sig,
				blocks: [...merged],
			};
			await this.adapter.write(`${dir}/${name}`, JSON.stringify(payload));
			this.diskNames.add(name);
			for (const k of keys) fc.dirty.delete(k);
		}).catch((e) => console.warn("web-lookup: could not write cache", e));
	}
}
