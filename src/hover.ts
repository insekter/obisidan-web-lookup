import { TFile } from "obsidian";
import type WebLookupPlugin from "./main";
import { formatQuery } from "./tokenizer";

/**
 * Hit-testing is purely DOM based, so one code path serves the editor (source + live
 * preview), reading view, canvas text cards and the PDF viewer's text layer:
 *
 *   pointer -> caret position -> text node -> "block" (line / paragraph / PDF page)
 *   -> block text + node offsets -> cached tokens -> token under the pointer
 *
 * The pointer must actually be over the token's glyph boxes; the caret lookup alone
 * would also match empty space to the right of a line.
 */

const HIGHLIGHT_NAME = "lookuptext-hover";

/** Where the feature is active. */
const ALLOWED =
	".markdown-source-view, .markdown-preview-view, .markdown-rendered, .textLayer, .canvas-node-content";
/** Never trigger on these. */
const EXCLUDED = "input, textarea, select, button, .cm-gutters, .cm-foldGutter, .cm-fold-indicator";
const LINK_SELECTOR =
	"a, .cm-hmd-internal-link, .cm-hmd-external-link, .cm-link, .cm-url, .internal-link, .external-link";

const BLOCK_TAGS = new Set([
	"P", "DIV", "LI", "UL", "OL", "DL", "DT", "DD", "TR", "TD", "TH", "TABLE", "THEAD", "TBODY",
	"H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "HR", "SECTION", "ARTICLE",
	"HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "SVG", "IMG", "CANVAS", "VIDEO", "AUDIO", "IFRAME"]);

interface Segment {
	node: Text;
	start: number;
	end: number;
}
interface BlockText {
	text: string;
	segs: Segment[];
}
interface Hit {
	range: Range;
	query: string;
	onLink: boolean;
}
type Modifier = "ctrl" | "alt" | "shift" | "meta";

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

interface CaretDocument {
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
}

interface HighlightWindow extends Window {
	CSS?: {
		highlights?: {
			set: (name: string, highlight: unknown) => void;
			delete: (name: string) => void;
		};
	};
	Highlight?: new (range: Range) => unknown;
}

function caretFromPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
	const d = doc as unknown as CaretDocument;
	if (typeof d.caretRangeFromPoint === "function") {
		const r: Range | null = d.caretRangeFromPoint(x, y);
		return r ? { node: r.startContainer, offset: r.startOffset } : null;
	}
	if (typeof d.caretPositionFromPoint === "function") {
		const p = d.caretPositionFromPoint(x, y);
		return p ? { node: p.offsetNode, offset: p.offset } : null;
	}
	return null;
}

function findBlock(node: Text): { el: HTMLElement; pdf: boolean } | null {
	const parent = node.parentElement;
	if (!parent) return null;
	const root = parent.closest<HTMLElement>(ALLOWED);
	if (!root || parent.closest(EXCLUDED)) return null;

	const pdf = parent.closest<HTMLElement>(".textLayer");
	if (pdf) return { el: pdf, pdf: true };

	const line = parent.closest<HTMLElement>(".cm-line");
	if (line) return { el: line, pdf: false };

	let cur: HTMLElement | null = parent;
	while (cur && cur !== root) {
		if (BLOCK_TAGS.has(cur.tagName)) return { el: cur, pdf: false };
		cur = cur.parentElement;
	}
	return { el: root, pdf: false };
}

/** Concatenated visible text of a block, with a map from string offsets to text nodes. */
function buildBlockText(block: HTMLElement, pdf: boolean): BlockText {
	const win = block.ownerDocument.defaultView;
	let text = "";
	const segs: Segment[] = [];
	const sep = () => {
		if (text.length > 0 && !text.endsWith("\n")) text += "\n";
	};

	const walk = (parent: Node) => {
		for (let c = parent.firstChild; c; c = c.nextSibling) {
			if (c.nodeType === 3) {
				const t = c as Text;
				const data = t.data;
				if (data.length === 0) continue;
				segs.push({ node: t, start: text.length, end: text.length + data.length });
				text += data;
			} else if (c.nodeType === 1) {
				const el = c as HTMLElement;
				const tag = el.tagName;
				if (SKIP_TAGS.has(tag.toUpperCase())) continue;
				if (tag === "BR") {
					sep();
					continue;
				}
				// skip hidden syntax markers etc. (computed style is too costly for big PDF pages)
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

function makeRange(doc: Document, bt: BlockText, start: number, end: number): Range | null {
	let sNode: Text | null = null;
	let sOff = 0;
	let eNode: Text | null = null;
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

function containsPoint(range: Range, x: number, y: number): boolean {
	const tol = 1;
	for (const rect of Array.from(range.getClientRects())) {
		if (x >= rect.left - tol && x <= rect.right + tol && y >= rect.top - tol && y <= rect.bottom + tol) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class HoverController {
	private modDown = false;
	private last: { x: number; y: number; doc: Document } | null = null;
	private raf = 0;
	private highlightWin: Window | null = null;
	private hitDoc: Document | null = null;
	private swallowUntil = 0;

	constructor(private plugin: WebLookupPlugin) { }

	/** Register listeners for one window (main window or a popout). */
	attach(win: Window): void {
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
	dispose(): void {
		this.reset();
	}

	// ------------------------------------------------------------- modifiers

	private exact(e: MouseEvent | KeyboardEvent): boolean {
		const m: Modifier = this.plugin.settings.modifier;
		return (
			e.ctrlKey === (m === "ctrl") &&
			e.altKey === (m === "alt") &&
			e.shiftKey === (m === "shift") &&
			e.metaKey === (m === "meta")
		);
	}

	// ---------------------------------------------------------------- events

	private onMove = (e: MouseEvent): void => {
		this.last = { x: e.clientX, y: e.clientY, doc: e.view?.document ?? document };
		if (!this.exact(e)) {
			if (this.modDown) this.reset();
			return;
		}
		this.modDown = true;
		this.schedule();
	};

	private onKey = (e: KeyboardEvent): void => {
		const down = this.exact(e);
		if (down === this.modDown) return;
		this.modDown = down;
		if (down) this.schedule();
		else this.reset();
	};

	private onDown = (e: MouseEvent): void => {
		if (e.button !== 0 || !this.exact(e)) return;
		const doc = e.view?.document ?? document;
		const hit = this.resolve(doc, e.clientX, e.clientY);
		if (!hit) return;
		if (hit.onLink && this.plugin.settings.ignoreLinks) return;

		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		this.swallowUntil = Date.now() + 400; // also swallow the click / macOS context menu that follows
		this.reset();
		void this.plugin.search(hit.query);
	};

	private swallow = (e: Event): void => {
		if (Date.now() < this.swallowUntil) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	};

	private reset = (): void => {
		this.modDown = false;
		if (this.raf) {
			window.cancelAnimationFrame(this.raf);
			this.raf = 0;
		}
		this.show(null);
	};

	// ---------------------------------------------------------------- update

	private schedule(): void {
		if (this.raf) return;
		this.raf = window.requestAnimationFrame(() => {
			this.raf = 0;
			if (!this.modDown || !this.last) return this.show(null);
			this.show(this.resolve(this.last.doc, this.last.x, this.last.y));
		});
	}

	private show(hit: Hit | null): void {
		// highlight
		const doc = hit ? hit.range.startContainer.ownerDocument : null;
		const win = doc?.defaultView ?? null;
		if (this.highlightWin && this.highlightWin !== win) {
			(this.highlightWin as HighlightWindow).CSS?.highlights?.delete(HIGHLIGHT_NAME);
			this.highlightWin = null;
		}
		if (win) {
			const w = win as unknown as HighlightWindow;
			if (w.CSS?.highlights && w.Highlight && hit) {
				w.CSS.highlights.set(HIGHLIGHT_NAME, new w.Highlight(hit.range));
				this.highlightWin = win;
			}
		}
		if (!hit && this.highlightWin) {
			(this.highlightWin as HighlightWindow).CSS?.highlights?.delete(HIGHLIGHT_NAME);
			this.highlightWin = null;
		}

		// pointer cursor
		if (this.hitDoc && this.hitDoc !== doc) this.hitDoc.body.classList.remove("lookuptext-hit");
		if (doc) doc.body.classList.add("lookuptext-hit");
		this.hitDoc = doc;
	}

	// ------------------------------------------------------------ resolution

	private fileFor(el: Element): TFile | null {
		const found: TFile[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (found.length === 0 && leaf.view.containerEl.contains(el)) {
				const view = leaf.view as unknown as { file?: unknown };
				if (view.file instanceof TFile) found.push(view.file);
			}
		});
		return found[0] ?? null;
	}

	private resolve(doc: Document, x: number, y: number): Hit | null {
		const caret = caretFromPoint(doc, x, y);
		if (!caret || caret.node.nodeType !== 3) return null;
		const node = caret.node as Text;

		const block = findBlock(node);
		if (!block) return null;

		const bt = buildBlockText(block.el, block.pdf);
		const seg = bt.segs.find((s) => s.node === node);
		if (!seg) return null;
		const g = seg.start + Math.min(caret.offset, node.length);

		const tokens = this.plugin.cache.getTokens(this.fileFor(block.el), bt.text);
		const s = this.plugin.settings;

		for (let i = 0; i < tokens.length; i += 2) {
			const start = tokens[i];
			const end = tokens[i + 1];
			if (g < start) break; // tokens are ascending
			if (g > end) continue;
			const range = makeRange(doc, bt, start, end);
			if (!range || !containsPoint(range, x, y)) continue;
			const query = formatQuery(bt.text.slice(start, end), s);
			if (!query) return null;
			return { range, query, onLink: !!node.parentElement?.closest(LINK_SELECTOR) };
		}
		return null;
	}
}
