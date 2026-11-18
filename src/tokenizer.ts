/**
 * Tokenizer.
 *
 * Two stages, deliberately separated:
 *
 *  1. tokenize()  – finds token boundaries as [start, end) offsets into the ORIGINAL
 *                   text. Depends on: delimiters, punctuation handling, language.
 *                   Output is what gets cached (so changing these settings
 *                   invalidates caches).
 *
 *  2. formatQuery() – turns one raw token into the final search string. Depends on:
 *                   case handling, normalization. Applied AFTER cache lookup, so
 *                   changing these never invalidates caches and offsets always
 *                   stay aligned with the DOM text.
 */

export type DelimiterMode = "unicode" | "whitespace" | "custom";
export type PunctuationMode = "strip" | "inner" | "keep";
export type CaseMode = "preserve" | "lowercase" | "uppercase";
export type NormalizationMode =
	| "none"
	| "NFC"
	| "NFD"
	| "NFKC"
	| "NFKD"
	| "strip-diacritics";

export interface TokenizerOptions {
	delimiterMode: DelimiterMode;
	customDelimiters: string;
	language: string;
	punctuation: PunctuationMode;
}

export interface QueryFormatOptions {
	caseMode: CaseMode;
	normalization: NormalizationMode;
}

/** Anything that is not a letter, number or combining mark. */
const NON_WORD = /[^\p{L}\p{N}\p{M}]+/gu;
const LEADING_NON_WORD = /^[^\p{L}\p{N}\p{M}]*/u;
const TRAILING_NON_WORD = /[^\p{L}\p{N}\p{M}]*$/u;
const HAS_CONTENT = /[\p{L}\p{N}]/u;
const HAS_NON_SPACE = /\S/u;

/** Punctuation that may sit *inside* a word in "inner" / "keep" mode: well-known, don't, snake_case, e.g */
const INNER_PUNCT = new Set(["-", "\u2010", "\u2011", "'", "\u2019", "_", "."]);

const segmenters = new Map<string, Intl.Segmenter>();

function getSegmenter(language: string): Intl.Segmenter {
	const key = language.trim();
	let seg = segmenters.get(key);
	if (!seg) {
		try {
			seg = new Intl.Segmenter(key || undefined, { granularity: "word" });
		} catch {
			// invalid BCP-47 tag
			seg = new Intl.Segmenter(undefined, { granularity: "word" });
		}
		segmenters.set(key, seg);
	}
	return seg;
}

export function tokenizerSignature(o: TokenizerOptions): string {
	return [
		"v1",
		o.delimiterMode,
		o.delimiterMode === "custom" ? o.customDelimiters : "",
		o.delimiterMode === "unicode" ? o.language.trim() : "",
		o.punctuation,
	].join("|");
}

/** Returns a flat array [s0, e0, s1, e1, ...] of token boundaries, ascending. */
export function tokenize(text: string, o: TokenizerOptions): Uint32Array {
	const out: number[] = [];
	const push = (s: number, e: number) => {
		if (e > s && HAS_CONTENT.test(text.slice(s, e))) out.push(s, e);
	};

	if (o.delimiterMode === "unicode") tokenizeUnicode(text, o, push);
	else tokenizeDelimited(text, o, push);

	return Uint32Array.from(out);
}

type Push = (s: number, e: number) => void;

function tokenizeUnicode(text: string, o: TokenizerOptions, push: Push): void {
	interface Part {
		s: number;
		e: number;
		w: boolean;
	}
	const parts: Part[] = [];
	for (const p of getSegmenter(o.language).segment(text)) {
		parts.push({ s: p.index, e: p.index + p.segment.length, w: !!p.isWordLike });
	}
	const n = parts.length;
	const isPunct = (i: number) =>
		!parts[i].w && HAS_NON_SPACE.test(text.slice(parts[i].s, parts[i].e));
	const isInner = (i: number) =>
		!parts[i].w && parts[i].e - parts[i].s === 1 && INNER_PUNCT.has(text[parts[i].s]);

	let consumed = 0;
	for (let i = 0; i < n;) {
		if (!parts[i].w) {
			i++;
			continue;
		}
		let a = i;
		let b = i + 1;
		if (o.punctuation !== "strip") {
			// glue word - word across inner punctuation
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

function escapeClass(s: string): string {
	return Array.from(s)
		.map((ch) => (ch === "\\" || ch === "[" || ch === "]" || ch === "-" ? `\\${ch}` : ch))
		.join("");
}

function tokenizeDelimited(text: string, o: TokenizerOptions, push: Push): void {
	let re: RegExp;
	try {
		re =
			o.delimiterMode === "whitespace"
				? /\s+/gu
				: new RegExp(`[\\s${escapeClass(o.customDelimiters)}]+`, "gu");
	} catch {
		re = /\s+/gu;
	}

	const emit = (s: number, e: number) => {
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
		// strip: every run of punctuation/symbols is a delimiter
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

/** Final search string for one raw token. */
export function formatQuery(raw: string, o: QueryFormatOptions): string {
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
