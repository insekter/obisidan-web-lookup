"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => WebLookupPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian5 = require("obsidian");

// src/cache.ts
var import_obsidian = require("obsidian");

// src/tokenizer.ts
var NON_WORD = /[^\p{L}\p{N}\p{M}]+/gu;
var LEADING_NON_WORD = /^[^\p{L}\p{N}\p{M}]*/u;
var TRAILING_NON_WORD = /[^\p{L}\p{N}\p{M}]*$/u;
var HAS_CONTENT = /[\p{L}\p{N}]/u;
var HAS_NON_SPACE = /\S/u;
var INNER_PUNCT = /* @__PURE__ */ new Set(["-", "\u2010", "\u2011", "'", "\u2019", "_", "."]);
var segmenters = /* @__PURE__ */ new Map();
function getSegmenter(language) {
  const key = language.trim();
  let seg = segmenters.get(key);
  if (!seg) {
    try {
      seg = new Intl.Segmenter(key || void 0, { granularity: "word" });
    } catch {
      seg = new Intl.Segmenter(void 0, { granularity: "word" });
    }
    segmenters.set(key, seg);
  }
  return seg;
}
function tokenizerSignature(o) {
  return [
    "v1",
    o.delimiterMode,
    o.delimiterMode === "custom" ? o.customDelimiters : "",
    o.delimiterMode === "unicode" ? o.language.trim() : "",
    o.punctuation
  ].join("|");
}
function tokenize(text, o) {
  const out = [];
  const push = (s, e) => {
    if (e > s && HAS_CONTENT.test(text.slice(s, e))) out.push(s, e);
  };
  if (o.delimiterMode === "unicode") tokenizeUnicode(text, o, push);
  else tokenizeDelimited(text, o, push);
  return Uint32Array.from(out);
}
function tokenizeUnicode(text, o, push) {
  const parts = [];
  for (const p of getSegmenter(o.language).segment(text)) {
    parts.push({ s: p.index, e: p.index + p.segment.length, w: !!p.isWordLike });
  }
  const n = parts.length;
  const isPunct = (i) => !parts[i].w && HAS_NON_SPACE.test(text.slice(parts[i].s, parts[i].e));
  const isInner = (i) => !parts[i].w && parts[i].e - parts[i].s === 1 && INNER_PUNCT.has(text[parts[i].s]);
  let consumed = 0;
  for (let i = 0; i < n; ) {
    if (!parts[i].w) {
      i++;
      continue;
    }
    let a = i;
    let b = i + 1;
    if (o.punctuation !== "strip") {
      while (b + 1 < n && isInner(b) && parts[b + 1].w) b += 2;
    }
    if (o.punctuation === "keep") {
      while (a - 1 >= consumed && isPunct(a - 1)) a--;
      while (b < n && isPunct(b)) b++;
    }
    push(parts[a].s, parts[b - 1].e);
    consumed = b;
    i = b;
  }
}
function escapeClass(s) {
  return s.replace(/[\\\]\[^-]/g, "\\$&");
}
function tokenizeDelimited(text, o, push) {
  let re;
  try {
    re = o.delimiterMode === "whitespace" ? /\s+/gu : new RegExp(`[\\s${escapeClass(o.customDelimiters)}]+`, "gu");
  } catch {
    re = /\s+/gu;
  }
  const emit = (s, e) => {
    if (e <= s) return;
    if (o.punctuation === "keep") {
      push(s, e);
      return;
    }
    const chunk = text.slice(s, e);
    if (o.punctuation === "inner") {
      const lead = LEADING_NON_WORD.exec(chunk)?.[0].length ?? 0;
      const trail = TRAILING_NON_WORD.exec(chunk)?.[0].length ?? 0;
      if (s + lead < e - trail) push(s + lead, e - trail);
      return;
    }
    let last = 0;
    for (const m of chunk.matchAll(NON_WORD)) {
      const idx = m.index ?? 0;
      if (idx > last) push(s + last, s + idx);
      last = idx + m[0].length;
    }
    if (last < chunk.length) push(s + last, e);
  };
  let pos = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    emit(pos, idx);
    pos = idx + m[0].length;
  }
  emit(pos, text.length);
}
function formatQuery(raw, o) {
  let s = raw;
  switch (o.normalization) {
    case "NFC":
    case "NFD":
    case "NFKC":
    case "NFKD":
      s = s.normalize(o.normalization);
      break;
    case "strip-diacritics":
      s = s.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
      break;
    default:
      break;
  }
  if (o.caseMode === "lowercase") s = s.toLowerCase();
  else if (o.caseMode === "uppercase") s = s.toUpperCase();
  return s.trim();
}

// src/cache.ts
var DISK_VERSION = 1;
var MAX_RAM_TOKENS = 1e6;
var MAX_DISK_BLOCKS = 5e4;
var ANON_BLOCKS = 128;
var FLUSH_DELAY_MS = 4e3;
function cyrb53(str) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
function blockKey(text) {
  return `${text.length.toString(36)}-${cyrb53(text).toString(36)}`;
}
var TokenCache = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.files = /* @__PURE__ */ new Map();
    this.anon = this.makeFileCache("", null);
    this.diskNames = /* @__PURE__ */ new Set();
    this.totalTokens = 0;
    this.flushTimer = null;
    this.flushQueue = /* @__PURE__ */ new Set();
    this.io = Promise.resolve();
    this.preloaded = false;
    this.sig = tokenizerSignature(plugin.settings);
  }
  // ------------------------------------------------------------------ setup
  async init() {
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
  async shutdown() {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushAll();
  }
  onSettingsChanged() {
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
  getTokens(file, text) {
    const fc = file ? this.fileCache(file) : this.anon;
    const key = blockKey(text);
    const hit = fc.blocks.get(key);
    if (hit) {
      fc.blocks.delete(key);
      fc.blocks.set(key, hit);
      return hit;
    }
    const tokens = tokenize(text, this.plugin.settings);
    this.put(fc, key, tokens);
    return tokens;
  }
  forget(path) {
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
        }
      });
    }
  }
  async clearAll() {
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
        }
      }
    });
  }
  async getStats() {
    let ramBlocks = 0;
    for (const fc of this.files.values()) ramBlocks += fc.blocks.size;
    let diskBytes = 0;
    for (const n of this.diskNames) {
      try {
        const st = await this.adapter.stat(`${this.cacheDir()}/${n}`);
        diskBytes += st?.size ?? 0;
      } catch {
      }
    }
    return {
      ramFiles: this.files.size,
      ramBlocks,
      ramTokens: this.totalTokens,
      diskFiles: this.diskNames.size,
      diskBytes
    };
  }
  // -------------------------------------------------------------- RAM layer
  get adapter() {
    return this.plugin.app.vault.adapter;
  }
  makeFileCache(path, file) {
    return {
      path,
      file,
      mtime: file?.stat.mtime ?? 0,
      size: file?.stat.size ?? 0,
      blocks: /* @__PURE__ */ new Map(),
      dirty: /* @__PURE__ */ new Set(),
      tokens: 0,
      load: "loaded"
    };
  }
  fileCache(file) {
    let fc = this.files.get(file.path);
    if (fc && (fc.mtime !== file.stat.mtime || fc.size !== file.stat.size)) {
      this.dropFile(fc);
      fc = void 0;
    }
    if (!fc) {
      fc = this.makeFileCache(file.path, file);
      fc.load = "none";
      this.files.set(file.path, fc);
    } else {
      this.files.delete(file.path);
      this.files.set(file.path, fc);
    }
    if (fc.load === "none") {
      if (this.diskNames.has(this.nameFor(file.path))) void this.loadFromDisk(fc);
      else fc.load = "loaded";
    }
    return fc;
  }
  dropFile(fc) {
    if (this.files.get(fc.path) === fc) {
      this.files.delete(fc.path);
      this.totalTokens -= fc.tokens;
    }
  }
  put(fc, key, tokens) {
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
  removeBlock(fc, key) {
    const t = fc.blocks.get(key);
    if (t) {
      fc.tokens -= t.length / 2;
      this.totalTokens -= t.length / 2;
    }
    fc.blocks.delete(key);
    fc.dirty.delete(key);
  }
  trim(fc) {
    const s = this.plugin.settings;
    const limit = fc === this.anon ? ANON_BLOCKS : s.slidingWindow ? Math.max(8, s.windowSize) : Infinity;
    while (fc.blocks.size > limit) {
      const oldest = fc.blocks.keys().next().value;
      if (oldest === void 0) break;
      this.removeBlock(fc, oldest);
    }
  }
  enforceGlobalLimit(current) {
    while (this.totalTokens > MAX_RAM_TOKENS) {
      const oldestPath = this.files.keys().next().value;
      if (oldestPath === void 0) break;
      const victim = this.files.get(oldestPath);
      if (!victim) break;
      if (victim === current && this.files.size === 1) {
        const k = victim.blocks.keys().next().value;
        if (k === void 0) break;
        this.removeBlock(victim, k);
        continue;
      }
      if (victim.dirty.size > 0) void this.flushFile(victim);
      this.dropFile(victim);
    }
  }
  // ------------------------------------------------------------- disk layer
  cacheDir() {
    const base = this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
    return `${base}/cache`;
  }
  nameFor(path) {
    return `${cyrb53(path).toString(36)}.json`;
  }
  enqueue(fn) {
    const run = this.io.then(fn, fn);
    this.io = run.catch(() => void 0);
    return run;
  }
  async readRaw(name) {
    const p = `${this.cacheDir()}/${name}`;
    try {
      if (!await this.adapter.exists(p)) {
        this.diskNames.delete(name);
        return null;
      }
      const d = JSON.parse(await this.adapter.read(p));
      if (d.v !== DISK_VERSION || !Array.isArray(d.blocks)) return null;
      return d;
    } catch (e) {
      console.warn("web-lookup: unreadable cache file", name, e);
      return null;
    }
  }
  isValid(d, file) {
    return d.path === file.path && d.sig === this.sig && d.mtime === file.stat.mtime && d.size === file.stat.size;
  }
  async removeDisk(name) {
    this.diskNames.delete(name);
    try {
      await this.adapter.remove(`${this.cacheDir()}/${name}`);
    } catch {
    }
  }
  /** Disk -> RAM for one file. Disk data is older than anything already in RAM. */
  async loadFromDisk(fc) {
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
  mergeFromDisk(fc, disk) {
    const merged = /* @__PURE__ */ new Map();
    for (const [k, arr] of disk.blocks) merged.set(k, Uint32Array.from(arr));
    let added = 0;
    for (const [k, v] of merged) if (!fc.blocks.has(k)) added += v.length / 2;
    for (const [k, v] of fc.blocks) {
      merged.delete(k);
      merged.set(k, v);
    }
    fc.blocks = merged;
    fc.tokens += added;
    this.totalTokens += added;
    this.trim(fc);
    this.enforceGlobalLimit(fc);
  }
  /** Eager mode: load every valid cache file into RAM. */
  async preloadAll() {
    this.preloaded = true;
    for (const name of [...this.diskNames]) {
      if (this.totalTokens >= MAX_RAM_TOKENS) break;
      const d = await this.enqueue(() => this.readRaw(name));
      if (!d) continue;
      const f = this.plugin.app.vault.getAbstractFileByPath(d.path);
      if (!(f instanceof import_obsidian.TFile) || !this.isValid(d, f)) {
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
  shouldPersist(file, tokenCount) {
    const s = this.plugin.settings;
    const ext = file.extension.toLowerCase();
    if (s.permanentFiletypes.includes(ext)) return true;
    for (const dir of s.permanentDirectories) {
      if (dir === "" || file.path === dir || file.path.startsWith(`${dir}/`)) return true;
    }
    const useAge = s.mtimeThresholdDays > 0;
    const useCount = s.tokenCountThreshold > 0;
    if (!useAge && !useCount) return false;
    if (useAge && Date.now() - file.stat.mtime < s.mtimeThresholdDays * 864e5) return false;
    if (useCount && tokenCount < s.tokenCountThreshold) return false;
    return true;
  }
  queueFlush(fc) {
    this.flushQueue.add(fc);
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushAll();
    }, FLUSH_DELAY_MS);
  }
  async flushAll() {
    const queue = [...this.flushQueue];
    this.flushQueue.clear();
    for (const fc of queue) await this.flushFile(fc);
  }
  async flushFile(fc) {
    const file = fc.file;
    if (!file || fc.dirty.size === 0) return;
    const keys = [...fc.dirty];
    const fresh = /* @__PURE__ */ new Map();
    for (const k of keys) {
      const t = fc.blocks.get(k);
      if (t) fresh.set(k, Array.from(t));
    }
    if (fresh.size === 0) return;
    await this.enqueue(async () => {
      if (file.stat.mtime !== fc.mtime || file.stat.size !== fc.size) return;
      const name = this.nameFor(fc.path);
      let disk = await this.readRaw(name);
      if (disk && !this.isValid(disk, file)) disk = null;
      const merged = new Map(disk ? disk.blocks : []);
      for (const [k, arr] of fresh) {
        merged.delete(k);
        merged.set(k, arr);
      }
      let count = 0;
      for (const arr of merged.values()) count += arr.length / 2;
      if (!this.shouldPersist(file, count)) return;
      while (merged.size > MAX_DISK_BLOCKS) {
        const oldest = merged.keys().next().value;
        if (oldest === void 0) break;
        merged.delete(oldest);
      }
      const dir = this.cacheDir();
      if (!await this.adapter.exists(dir)) await this.adapter.mkdir(dir);
      const payload = {
        v: DISK_VERSION,
        path: fc.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
        sig: this.sig,
        blocks: [...merged]
      };
      await this.adapter.write(`${dir}/${name}`, JSON.stringify(payload));
      this.diskNames.add(name);
      for (const k of keys) fc.dirty.delete(k);
    }).catch((e) => console.warn("web-lookup: could not write cache", e));
  }
};

// src/hover.ts
var import_obsidian2 = require("obsidian");
var HIGHLIGHT_NAME = "lookuptext-hover";
var ALLOWED = ".markdown-source-view, .markdown-preview-view, .markdown-rendered, .textLayer, .canvas-node-content";
var EXCLUDED = "input, textarea, select, button, .cm-gutters, .cm-foldGutter, .cm-fold-indicator";
var LINK_SELECTOR = "a, .cm-hmd-internal-link, .cm-hmd-external-link, .cm-link, .cm-url, .internal-link, .external-link";
var BLOCK_TAGS = /* @__PURE__ */ new Set([
  "P",
  "DIV",
  "LI",
  "UL",
  "OL",
  "DL",
  "DT",
  "DD",
  "TR",
  "TD",
  "TH",
  "TABLE",
  "THEAD",
  "TBODY",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "HR",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "FIGURE",
  "FIGCAPTION",
  "DETAILS",
  "SUMMARY"
]);
var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "SVG", "IMG", "CANVAS", "VIDEO", "AUDIO", "IFRAME"]);
function caretFromPoint(doc, x, y) {
  const d = doc;
  if (typeof d.caretRangeFromPoint === "function") {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (typeof d.caretPositionFromPoint === "function") {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}
function findBlock(node) {
  const parent = node.parentElement;
  if (!parent) return null;
  const root = parent.closest(ALLOWED);
  if (!root || parent.closest(EXCLUDED)) return null;
  const pdf = parent.closest(".textLayer");
  if (pdf) return { el: pdf, pdf: true };
  const line = parent.closest(".cm-line");
  if (line) return { el: line, pdf: false };
  let cur = parent;
  while (cur && cur !== root) {
    if (BLOCK_TAGS.has(cur.tagName)) return { el: cur, pdf: false };
    cur = cur.parentElement;
  }
  return { el: root, pdf: false };
}
function buildBlockText(block, pdf) {
  const win = block.ownerDocument.defaultView;
  let text = "";
  const segs = [];
  const sep = () => {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  };
  const walk = (parent) => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        const t = c;
        const data = t.data;
        if (data.length === 0) continue;
        segs.push({ node: t, start: text.length, end: text.length + data.length });
        text += data;
      } else if (c.nodeType === 1) {
        const el = c;
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag.toUpperCase())) continue;
        if (tag === "BR") {
          sep();
          continue;
        }
        if (!pdf && win && win.getComputedStyle(el).display === "none") continue;
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) sep();
        walk(el);
        if (isBlock) sep();
      }
    }
  };
  walk(block);
  return { text, segs };
}
function makeRange(doc, bt, start, end) {
  let sNode = null;
  let sOff = 0;
  let eNode = null;
  let eOff = 0;
  for (const seg of bt.segs) {
    if (!sNode && start >= seg.start && start < seg.end) {
      sNode = seg.node;
      sOff = start - seg.start;
    }
    if (!eNode && end > seg.start && end <= seg.end) {
      eNode = seg.node;
      eOff = end - seg.start;
    }
    if (sNode && eNode) break;
  }
  if (!sNode || !eNode) return null;
  const r = doc.createRange();
  try {
    r.setStart(sNode, sOff);
    r.setEnd(eNode, eOff);
  } catch {
    return null;
  }
  return r;
}
function containsPoint(range, x, y) {
  const tol = 1;
  for (const rect of Array.from(range.getClientRects())) {
    if (x >= rect.left - tol && x <= rect.right + tol && y >= rect.top - tol && y <= rect.bottom + tol) {
      return true;
    }
  }
  return false;
}
var HoverController = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.modDown = false;
    this.last = null;
    this.raf = 0;
    this.highlightWin = null;
    this.hitDoc = null;
    this.swallowUntil = 0;
    // ---------------------------------------------------------------- events
    this.onMove = (e) => {
      this.last = { x: e.clientX, y: e.clientY, doc: e.view?.document ?? document };
      if (!this.exact(e)) {
        if (this.modDown) this.reset();
        return;
      }
      this.modDown = true;
      this.schedule();
    };
    this.onKey = (e) => {
      const down = this.exact(e);
      if (down === this.modDown) return;
      this.modDown = down;
      if (down) this.schedule();
      else this.reset();
    };
    this.onDown = (e) => {
      if (e.button !== 0 || !this.exact(e)) return;
      const doc = e.view?.document ?? document;
      const hit = this.resolve(doc, e.clientX, e.clientY);
      if (!hit) return;
      if (hit.onLink && this.plugin.settings.ignoreLinks) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      this.swallowUntil = Date.now() + 400;
      this.reset();
      void this.plugin.search(hit.query);
    };
    this.swallow = (e) => {
      if (Date.now() < this.swallowUntil) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
    };
    this.reset = () => {
      this.modDown = false;
      if (this.raf) {
        window.cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      this.show(null);
    };
  }
  /** Register listeners for one window (main window or a popout). */
  attach(win) {
    const p = this.plugin;
    p.registerDomEvent(win, "mousemove", this.onMove, { capture: true, passive: true });
    p.registerDomEvent(win, "keydown", this.onKey, { capture: true });
    p.registerDomEvent(win, "keyup", this.onKey, { capture: true });
    p.registerDomEvent(win, "mousedown", this.onDown, { capture: true });
    p.registerDomEvent(win, "click", this.swallow, { capture: true });
    p.registerDomEvent(win, "contextmenu", this.swallow, { capture: true });
    p.registerDomEvent(win, "blur", this.reset);
  }
  /** Remove highlight and cursor state. */
  dispose() {
    this.reset();
  }
  // ------------------------------------------------------------- modifiers
  exact(e) {
    const m = this.plugin.settings.modifier;
    return e.ctrlKey === (m === "ctrl") && e.altKey === (m === "alt") && e.shiftKey === (m === "shift") && e.metaKey === (m === "meta");
  }
  // ---------------------------------------------------------------- update
  schedule() {
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.modDown || !this.last) return this.show(null);
      this.show(this.resolve(this.last.doc, this.last.x, this.last.y));
    });
  }
  show(hit) {
    const doc = hit ? hit.range.startContainer.ownerDocument : null;
    const win = doc?.defaultView ?? null;
    if (this.highlightWin && this.highlightWin !== win) {
      this.highlightWin.CSS?.highlights?.delete(HIGHLIGHT_NAME);
      this.highlightWin = null;
    }
    if (win) {
      const w = win;
      if (w.CSS?.highlights && w.Highlight && hit) {
        w.CSS.highlights.set(HIGHLIGHT_NAME, new w.Highlight(hit.range));
        this.highlightWin = win;
      }
    }
    if (!hit && this.highlightWin) {
      this.highlightWin.CSS?.highlights?.delete(HIGHLIGHT_NAME);
      this.highlightWin = null;
    }
    if (this.hitDoc && this.hitDoc !== doc) this.hitDoc.body.classList.remove("lookuptext-hit");
    if (doc) doc.body.classList.add("lookuptext-hit");
    this.hitDoc = doc;
  }
  // ------------------------------------------------------------ resolution
  fileFor(el) {
    const found = [];
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (found.length === 0 && leaf.view.containerEl.contains(el)) {
        const f = leaf.view.file;
        if (f instanceof import_obsidian2.TFile) found.push(f);
      }
    });
    return found[0] ?? null;
  }
  resolve(doc, x, y) {
    const caret = caretFromPoint(doc, x, y);
    if (!caret || caret.node.nodeType !== 3) return null;
    const node = caret.node;
    const block = findBlock(node);
    if (!block) return null;
    const bt = buildBlockText(block.el, block.pdf);
    const seg = bt.segs.find((s2) => s2.node === node);
    if (!seg) return null;
    const g = seg.start + Math.min(caret.offset, node.length);
    const tokens = this.plugin.cache.getTokens(this.fileFor(block.el), bt.text);
    const s = this.plugin.settings;
    for (let i = 0; i < tokens.length; i += 2) {
      const start = tokens[i];
      const end = tokens[i + 1];
      if (g < start) break;
      if (g > end) continue;
      const range = makeRange(doc, bt, start, end);
      if (!range || !containsPoint(range, x, y)) continue;
      const query = formatQuery(bt.text.slice(start, end), s);
      if (!query) return null;
      return { range, query, onLink: !!node.parentElement?.closest(LINK_SELECTOR) };
    }
    return null;
  }
};

// src/search.ts
var import_obsidian3 = require("obsidian");
var ENGINES = {
  google: { label: "Google", url: (q) => `https://www.google.com/search?q=${q}` },
  duckduckgo: { label: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${q}` },
  bing: { label: "Bing", url: (q) => `https://www.bing.com/search?q=${q}` },
  yandex: { label: "Yandex", url: (q) => `https://yandex.com/search/?text=${q}` },
  baidu: { label: "Baidu", url: (q) => `https://www.baidu.com/s?wd=${q}` }
};
function isWebViewerEnabled(app) {
  if (!import_obsidian3.Platform.isDesktopApp) return false;
  try {
    const ip = app.internalPlugins;
    if (ip?.getEnabledPluginById?.("webviewer")) return true;
    return !!ip?.plugins?.["webviewer"]?.enabled;
  } catch {
    return false;
  }
}
function buildSearchUrl(engine, query) {
  return ENGINES[engine].url(encodeURIComponent(query));
}
async function openSearch(plugin, query) {
  const s = plugin.settings;
  const url = buildSearchUrl(s.searchEngine, query);
  if (s.openInBrowser === "webviewer") {
    if (await openInWebViewer(plugin, url)) return;
    new import_obsidian3.Notice("web-lookup: Web viewer unavailable, opened in the external browser.");
  }
  openExternal(url);
}
async function openInWebViewer(plugin, url) {
  const { app } = plugin;
  if (!isWebViewerEnabled(app)) return false;
  const fresh = plugin.settings.openInTab === "new-tab";
  const leaf = fresh ? app.workspace.getLeaf("tab") : app.workspace.getLeaf(false);
  try {
    await leaf.setViewState({
      type: "webviewer",
      active: true,
      state: { url, navigate: true }
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
function openExternal(url) {
  try {
    const electron = window.require?.("electron");
    if (electron?.shell?.openExternal) {
      void electron.shell.openExternal(url);
      return;
    }
  } catch {
  }
  window.open(url, "_blank");
}

// src/settings.ts
var import_obsidian4 = require("obsidian");
var DEFAULT_SETTINGS = {
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
  windowSize: 256
};
function parseList(raw, sep) {
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
}
function parseNonNegInt(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
var WebLookupSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    const save = async () => {
      await this.plugin.saveSettings();
    };
    new import_obsidian4.Setting(containerEl).setName("Search").setHeading();
    new import_obsidian4.Setting(containerEl).setName("Modifier key").setDesc("Hold this key, hover a word, then left-click to search it.").addDropdown(
      (d) => d.addOptions({ ctrl: "Ctrl", alt: "Alt / Option", shift: "Shift", meta: "Cmd / Win" }).setValue(s.modifier).onChange(async (v) => {
        s.modifier = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Let Obsidian handle links").setDesc("Ctrl+click on a link keeps its normal behavior instead of searching its text.").addToggle(
      (t) => t.setValue(s.ignoreLinks).onChange(async (v) => {
        s.ignoreLinks = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Search engine").addDropdown((d) => {
      const opts = {};
      for (const [k, e] of Object.entries(ENGINES)) opts[k] = e.label;
      d.addOptions(opts).setValue(s.searchEngine).onChange(async (v) => {
        s.searchEngine = v;
        await save();
      });
    });
    const wvOk = isWebViewerEnabled(this.app);
    new import_obsidian4.Setting(containerEl).setName("Open in browser").setDesc(
      "External uses your system browser. Built-in uses the Web viewer core plugin" + (wvOk ? "." : " (currently disabled or unavailable; the external browser will be used instead).")
    ).addDropdown(
      (d) => d.addOptions({ external: "External browser", webviewer: "Built-in Web viewer" }).setValue(s.openInBrowser).onChange(async (v) => {
        s.openInBrowser = v;
        await save();
        this.display();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Open in tab").setDesc("Only applies to the built-in Web viewer.").addDropdown(
      (d) => d.addOptions({ "new-tab": "New tab", "current-tab": "Current tab" }).setValue(s.openInTab).setDisabled(s.openInBrowser === "external").onChange(async (v) => {
        s.openInTab = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Tokenization").setHeading();
    new import_obsidian4.Setting(containerEl).setName("Delimiters").setDesc(
      "Unicode: language-aware word boundaries (also splits Chinese, Japanese, Thai). Whitespace: split on whitespace only. Custom: whitespace plus the characters you list."
    ).addDropdown(
      (d) => d.addOptions({
        unicode: "Unicode word boundaries",
        whitespace: "Whitespace only",
        custom: "Custom characters"
      }).setValue(s.delimiterMode).onChange(async (v) => {
        s.delimiterMode = v;
        await save();
        this.display();
      })
    );
    if (s.delimiterMode === "custom") {
      new import_obsidian4.Setting(containerEl).setName("Custom delimiter characters").setDesc("Every character typed here separates tokens, e.g. ,;/|").addText(
        (t) => t.setValue(s.customDelimiters).onChange(async (v) => {
          s.customDelimiters = v;
          await save();
        })
      );
    }
    if (s.delimiterMode === "unicode") {
      new import_obsidian4.Setting(containerEl).setName("Language").setDesc("Optional BCP 47 tag (e.g. ja, zh-Hans, th) that tunes word segmentation. Empty = default.").addText(
        (t) => t.setPlaceholder("auto").setValue(s.language).onChange(async (v) => {
          s.language = v.trim();
          await save();
        })
      );
    }
    new import_obsidian4.Setting(containerEl).setName("Punctuation handling").setDesc(
      "Split: punctuation always separates tokens. Keep inside words: don't, well-known stay whole, edge punctuation is dropped. Keep all: punctuation stays attached to the word."
    ).addDropdown(
      (d) => d.addOptions({ strip: "Split", inner: "Keep inside words", keep: "Keep all" }).setValue(s.punctuation).onChange(async (v) => {
        s.punctuation = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Case sensitivity").setDesc("Applied to the search string only.").addDropdown(
      (d) => d.addOptions({
        preserve: "Case-sensitive (keep as written)",
        lowercase: "Case-insensitive (lowercase)",
        uppercase: "Case-insensitive (UPPERCASE)"
      }).setValue(s.caseMode).onChange(async (v) => {
        s.caseMode = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Normalization").setDesc("Unicode normalization applied to the search string.").addDropdown(
      (d) => d.addOptions({
        none: "None",
        NFC: "NFC (composed)",
        NFD: "NFD (decomposed)",
        NFKC: "NFKC (compatibility, composed)",
        NFKD: "NFKD (compatibility, decomposed)",
        "strip-diacritics": "Strip diacritics (\xE9 \u2192 e)"
      }).setValue(s.normalization).onChange(async (v) => {
        s.normalization = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Permanent cache (disk)").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Token boundaries are cached per file as you hover. A file's cache is written to disk when it matches an always-rule below, or when it satisfies every threshold that is set (greater than 0)."
    });
    new import_obsidian4.Setting(containerEl).setName("Always cache file types").setDesc("Comma-separated extensions, e.g. pdf, md").addText(
      (t) => t.setPlaceholder("pdf").setValue(s.permanentFiletypes.join(", ")).onChange(async (v) => {
        s.permanentFiletypes = parseList(v.toLowerCase().replace(/\./g, ""), /[,\s]+/);
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Always cache directories").setDesc("One vault-relative folder per line. Subfolders are included.").addTextArea(
      (t) => t.setPlaceholder("Library/Papers").setValue(s.permanentDirectories.join("\n")).onChange(async (v) => {
        s.permanentDirectories = parseList(v, /\n+/).map((d) => d.replace(/^\/+|\/+$/g, ""));
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Modified-time threshold (days)").setDesc("Only cache files not modified for at least this many days. 0 = ignore this rule.").addText(
      (t) => t.setValue(String(s.mtimeThresholdDays)).onChange(async (v) => {
        s.mtimeThresholdDays = parseNonNegInt(v, s.mtimeThresholdDays);
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Token-count threshold").setDesc("Only cache files whose cached token count has reached this number. 0 = ignore this rule.").addText(
      (t) => t.setValue(String(s.tokenCountThreshold)).onChange(async (v) => {
        s.tokenCountThreshold = parseNonNegInt(v, s.tokenCountThreshold);
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Lazy loading").setDesc(
      "Yes: a file's cache is read from disk the first time you use that file. No: every cache file is loaded into memory when Obsidian starts."
    ).addToggle(
      (t) => t.setValue(s.lazyLoading).onChange(async (v) => {
        s.lazyLoading = v;
        await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Memory cache (RAM)").setHeading();
    new import_obsidian4.Setting(containerEl).setName("Sliding window").setDesc(
      "Yes: keep only the most recently used blocks (paragraphs, lines, PDF pages) of each file in memory. No: keep everything until the global memory limit is reached."
    ).addToggle(
      (t) => t.setValue(s.slidingWindow).onChange(async (v) => {
        s.slidingWindow = v;
        await save();
        this.display();
      })
    );
    if (s.slidingWindow) {
      new import_obsidian4.Setting(containerEl).setName("Window size (blocks per file)").addText(
        (t) => t.setValue(String(s.windowSize)).onChange(async (v) => {
          s.windowSize = Math.max(8, parseNonNegInt(v, s.windowSize));
          await save();
        })
      );
    }
    new import_obsidian4.Setting(containerEl).setName("Maintenance").setHeading();
    const statsSetting = new import_obsidian4.Setting(containerEl).setName("Cache status").setDesc("Loading\u2026");
    const refresh = async () => {
      const st = await this.plugin.cache.getStats();
      statsSetting.setDesc(
        `Memory: ${st.ramFiles} files, ${st.ramBlocks} blocks, ${st.ramTokens} tokens. Disk: ${st.diskFiles} files, ${fmtBytes(st.diskBytes)}.`
      );
    };
    void refresh();
    statsSetting.addButton((b) => b.setButtonText("Refresh").onClick(() => void refresh())).addButton(
      (b) => b.setButtonText("Clear all caches").setWarning().onClick(async () => {
        await this.plugin.cache.clearAll();
        new import_obsidian4.Notice("web-lookup: caches cleared.");
        await refresh();
      })
    );
  }
};

// src/main.ts
var WebLookupPlugin = class extends import_obsidian5.Plugin {
  async onload() {
    await this.loadSettings();
    this.cache = new TokenCache(this);
    this.hover = new HoverController(this);
    this.addSettingTab(new WebLookupSettingTab(this.app, this));
    this.addCommand({
      id: "clear-token-cache",
      name: "Clear tokenization caches",
      callback: async () => {
        await this.cache.clearAll();
        new import_obsidian5.Notice("web-lookup: caches cleared.");
      }
    });
    this.app.workspace.onLayoutReady(() => {
      this.hover.attach(window);
      void this.cache.init();
    });
    this.registerEvent(this.app.workspace.on("window-open", (_ws, win) => this.hover.attach(win)));
    const gone = (f) => this.cache.forget(f.path);
    this.registerEvent(this.app.vault.on("delete", gone));
    this.registerEvent(this.app.vault.on("rename", (_f, oldPath) => this.cache.forget(oldPath)));
  }
  onunload() {
    this.hover?.dispose();
    void this.cache?.shutdown();
  }
  async search(query) {
    await openSearch(this, query);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.cache.onSettingsChanged();
  }
};
