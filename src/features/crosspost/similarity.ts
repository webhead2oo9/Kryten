/**
 * Pure cross-post similarity engine — no Discord coupling, fully unit-testable.
 *
 * The scoring is frozen: normalization order, the canonical substitutions, and
 * the three algorithms (difflib-style sequence ratio, Jaccard, char-n-gram
 * cosine) reproduce the exact scores the detection thresholds were tuned
 * against. Change any of them and the thresholds silently drift. Threshold
 * *values* are configurable (see CrosspostHandler defaults); the engine only
 * produces the scores. Structurally, detection lives here and enforcement lives
 * in the handler.
 */

// `compare()` blends a `confidence` from these weights, but detection votes on
// the three raw scores directly (see countAlgorithmsTriggered) — nothing
// downstream reads `confidence`. Treat it as telemetry surface, not a live
// decision input.
const CONFIDENCE_WEIGHTS = { seq: 0.35, char: 0.35, jac: 0.3 } as const;

/** Canonical term substitutions applied during normalization (order matters). */
const CANONICAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bwi[\s\-]?fi\b/g, "wifi"],
    [/\bvirtual\s*desktop\b/g, "virtualdesktop"],
    [/\bvd\b/g, "virtualdesktop"],
    [/\b(meta\s*)?quest\s*pro\b|\bmq\s*pro\b/g, "questpro"],
    [/\b(meta\s*)?quest\s*3\b|\bmq3\b/g, "quest3"],
    [/\b(meta\s*)?quest\s*2\b|\bmq2\b/g, "quest2"],
    [/\b(meta\s*)?quest\b/g, "quest"],
    [/\b5\s*ghz\b/g, "5ghz"],
    [/\b2(\.|,)?4\s*ghz\b/g, "2.4ghz"],
    [/\bpc\s*vr\b|\bpcvr\b/g, "pcvr"],
    [/\b(link\s*cable|oculus\s*link)\b/g, "linkcable"],
];

const STOP_WORDS: ReadonlySet<string> = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "is",
    "in",
    "on",
    "for",
    "it",
    "that",
    "this",
    "with",
    "as",
    "are",
    "be",
    "was",
    "were",
    "at",
    "by",
    "from",
    "but",
    "if",
    "not",
    "can",
    "could",
    "would",
    "should",
    "i",
    "you",
    "we",
    "they",
    "he",
    "she",
    "please",
    "pls",
    "thanks",
    "thank",
    "hi",
    "hey",
    "hello",
    "any",
    "some",
    "my",
    "me",
    "us",
    "our",
    "your",
    "yours",
    "im",
    "id",
    "ive",
    "weve",
    "youre",
    "does",
    "did",
    "do",
    "so",
    "just",
    "still",
    "also",
    "there",
    "here",
    "help",
    "need",
    "got",
    "have",
]);

export interface SimilarityThresholds {
    sequenceRatioThreshold: number;
    charCosineThreshold: number;
    jaccardThreshold: number;
    minNormalizedLength: number;
    lengthRatioThreshold: number;
    minAlgorithmsToMatch: number;
}

/** Pre-computed comparison features for a single message. */
export interface Fingerprint {
    content: string;
    normalized: string;
    tokens: Set<string>;
    charNgrams: Map<string, number>;
    /** sqrt of the summed squared n-gram counts — the cosine denominator, computed once. */
    charNorm: number;
    /**
     * difflib b2j index of `normalized` (autojunk applied). A fingerprint is
     * compared as `prior` against every later message from the same user, so
     * precomputing the index here avoids rebuilding it per comparison.
     */
    seqIndex: Map<string, number[]>;
    deltaTokens: string[];
    deltaTokenSet: Set<string>;
    attachmentFingerprint: string;
}

/** Raw pairwise scores between two fingerprints. */
export interface Comparison {
    sequenceRatio: number;
    jaccard: number;
    charCosine: number;
    confidence: number;
    lengthRatio: number;
    newContentRatio: number;
}

/**
 * Faithful port of Python's `difflib.SequenceMatcher.ratio()` (Ratcliff/
 * Obershelp) including the autojunk heuristic, so ratios match the exact
 * values the detection thresholds were tuned against. Parity is enforced by
 * difflib-generated golden vectors in tests/similarity.test.ts.
 *
 * Iterates UTF-16 code units where Python iterates code points — only valid
 * for the ASCII-only normalized strings this engine produces; astral chars
 * (emoji) would be split into surrogate halves.
 *
 * `ratio()` is NOT symmetric in its arguments (autojunk applies to `b` only,
 * and tie-breaking is order-dependent) — never swap them as an optimization.
 */
export class SequenceMatcher {
    private a = "";
    private b = "";
    private b2j = new Map<string, number[]>();

    /** Build the b2j index (including autojunk) for a `b` sequence, reusable across calls. */
    static buildIndex(b: string): Map<string, number[]> {
        const b2j = new Map<string, number[]>();
        for (let i = 0; i < b.length; i++) {
            const ch = b[i]!;
            const arr = b2j.get(ch);
            if (arr) arr.push(i);
            else b2j.set(ch, [i]);
        }
        // autojunk: drop elements that appear in > 1% of a long b.
        if (b.length >= 200) {
            const ntest = Math.floor(b.length / 100) + 1;
            for (const [ch, idxs] of b2j) {
                if (idxs.length > ntest) b2j.delete(ch);
            }
        }
        return b2j;
    }

    /** `bIndex`, when provided, must be `buildIndex(b)` — it skips the per-call index rebuild. */
    setSeqs(a: string, b: string, bIndex?: Map<string, number[]>): void {
        this.a = a;
        if (bIndex) {
            this.b = b;
            this.b2j = bIndex;
        } else if (b !== this.b) {
            this.b = b;
            this.b2j = SequenceMatcher.buildIndex(b);
        }
    }

    private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
        const { a, b, b2j } = this;
        let besti = alo;
        let bestj = blo;
        let bestsize = 0;
        let j2len = new Map<number, number>();

        for (let i = alo; i < ahi; i++) {
            const newj2len = new Map<number, number>();
            const indices = b2j.get(a[i]!);
            if (indices) {
                for (const j of indices) {
                    if (j < blo) continue;
                    if (j >= bhi) break;
                    const k = (j2len.get(j - 1) ?? 0) + 1;
                    newj2len.set(j, k);
                    if (k > bestsize) {
                        besti = i - k + 1;
                        bestj = j - k + 1;
                        bestsize = k;
                    }
                }
            }
            j2len = newj2len;
        }

        // Extend the match across adjacent equal elements (no isjunk in use).
        while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
            besti--;
            bestj--;
            bestsize++;
        }
        while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
            bestsize++;
        }
        return [besti, bestj, bestsize];
    }

    ratio(): number {
        const la = this.a.length;
        const lb = this.b.length;
        const total = la + lb;
        if (total === 0) return 1.0;

        let matches = 0;
        const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
        while (queue.length) {
            const [alo, ahi, blo, bhi] = queue.pop()!;
            const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
            if (k) {
                matches += k;
                if (alo < i && blo < j) queue.push([alo, i, blo, j]);
                if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
            }
        }
        return (2.0 * matches) / total;
    }
}

export class SimilarityEngine {
    private readonly matcher = new SequenceMatcher();

    private applyCanonical(text: string): string {
        let result = text;
        for (const [pattern, replacement] of CANONICAL_PATTERNS) {
            result = result.replace(pattern, replacement);
        }
        return result;
    }

    /**
     * Ported-verbatim ordering quirks, locked by tests/similarity.test.ts:
     * the markdown-char strip runs BEFORE the emoji / code-fence / inline-code
     * removals, so every backtick and `>` is already a space when those
     * regexes run — they can never match (code text and emoji name/id leak
     * into tokens). The quote-line rule (`^[\s>].*$`) then deletes ANY line
     * whose first char became a space, so bullet/quoted lines vanish
     * wholesale. And the canonical "2.4ghz" form is re-split to "2 4ghz" by
     * the final punctuation strip. `tokenizeForDelta` sequences these steps in
     * the intended order, which suggests the ordering here is an upstream
     * VRDHelper bug — but the thresholds were tuned against these exact
     * outputs, so reordering is a scoring change requiring cross-bot
     * coordination and re-tuning, not a local cleanup.
     */
    normalizeContent(content: string): string {
        let text = content.normalize("NFKC").toLowerCase();
        text = text.replace(/https?:\/\/\S+/g, " ");
        text = text.replace(/<@!?\d+>/g, " ");
        text = text.replace(/<#\d+>/g, " ");
        text = text.replace(/[`*_~>|\\-]/g, " ");
        text = text.replace(/<a?:\w+:\d+>/g, " "); // dead: `>` already stripped above
        text = text.replace(/```[\s\S]*?```/g, " "); // dead: backticks already stripped above
        text = text.replace(/`[^`]+`/g, " "); // dead: backticks already stripped above
        text = text.replace(/^[\s>].*$/gm, " ");
        text = this.applyCanonical(text);
        text = text.replace(/[^a-z0-9\s]/g, " ");
        text = text.replace(/\s+/g, " ").trim();
        return text;
    }

    tokenize(normalized: string): Set<string> {
        if (!normalized) return new Set();
        const tokens = normalized.split(" ").filter(token => token && !STOP_WORDS.has(token));
        const result = new Set(tokens);
        for (let i = 0; i < tokens.length - 1; i++) {
            result.add(`${tokens[i]}_${tokens[i + 1]}`);
        }
        return result;
    }

    tokenizeForDelta(content: string): string[] {
        let text = content.normalize("NFKC").toLowerCase();
        text = text.replace(/```[\s\S]*?```/g, " ");
        text = text.replace(/`[^`]+`/g, " ");
        text = text.replace(/<@!?\d+>/g, " ");
        text = text.replace(/<#\d+>/g, " ");
        text = text.replace(/<a?:\w+:\d+>/g, " ");
        text = text.replace(/https?:\/\/\S+/g, " ");
        text = text.replace(/^[\s>].*$/gm, " ");
        text = this.applyCanonical(text);
        const tokens = text.match(/[a-z0-9.\-_/]+/g) ?? [];
        return tokens.filter(token => token && !STOP_WORDS.has(token));
    }

    charNgrams(text: string, nMin = 3, nMax = 5): Map<string, number> {
        const grams = new Map<string, number>();
        if (!text) return grams;
        if (text.length < nMin) {
            grams.set(text, 1);
            return grams;
        }
        const padded = ` ${text} `;
        const length = padded.length;
        for (let n = nMin; n <= nMax; n++) {
            for (let idx = 0; idx < Math.max(0, length - n + 1); idx++) {
                const gram = padded.slice(idx, idx + n);
                grams.set(gram, (grams.get(gram) ?? 0) + 1);
            }
        }
        return grams;
    }

    /** `normA`/`normB` are the fingerprints' precomputed `charNorm` values. */
    private cosine(a: Map<string, number>, b: Map<string, number>, normA: number, normB: number): number {
        if (a.size === 0 || b.size === 0) return 0.0;
        let dot = 0;
        for (const [key, value] of a) dot += value * (b.get(key) ?? 0);
        if (dot === 0) return 0.0;
        if (!normA || !normB) return 0.0;
        return dot / (normA * normB);
    }

    private jaccard(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 && b.size === 0) return 1.0;
        if (a.size === 0 || b.size === 0) return 0.0;
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        let intersection = 0;
        for (const item of small) if (large.has(item)) intersection++;
        const union = a.size + b.size - intersection;
        return union ? intersection / union : 0.0;
    }

    private sequenceRatio(a: string, b: string, bIndex?: Map<string, number[]>): number {
        if (!a && !b) return 1.0;
        if (!a || !b) return 0.0;
        this.matcher.setSeqs(a, b, bIndex);
        return this.matcher.ratio();
    }

    private newContentRatio(currentTokens: string[], priorTokenSet: Set<string>): number {
        if (currentTokens.length === 0) return 0.0;
        if (priorTokenSet.size === 0) return 1.0;
        let novel = 0;
        for (const token of currentTokens) if (!priorTokenSet.has(token)) novel++;
        return novel / currentTokens.length;
    }

    computeConfidence(seq: number, char: number, jac: number): number {
        return seq * CONFIDENCE_WEIGHTS.seq + char * CONFIDENCE_WEIGHTS.char + jac * CONFIDENCE_WEIGHTS.jac;
    }

    /** Build the reusable comparison features for one message. */
    fingerprint(content: string, attachmentFingerprint = ""): Fingerprint {
        const hasText = content.trim().length > 0;
        const normalized = hasText ? this.normalizeContent(content) : "";
        const deltaTokens = hasText ? this.tokenizeForDelta(content) : [];
        const charNgrams = hasText ? this.charNgrams(normalized) : new Map<string, number>();
        let normSq = 0;
        for (const value of charNgrams.values()) normSq += value * value;
        return {
            content: hasText ? content : "",
            normalized,
            tokens: hasText ? this.tokenize(normalized) : new Set(),
            charNgrams,
            charNorm: Math.sqrt(normSq),
            seqIndex: SequenceMatcher.buildIndex(normalized),
            deltaTokens,
            deltaTokenSet: new Set(deltaTokens),
            attachmentFingerprint,
        };
    }

    /** Raw pairwise scores. `current` is the new message, `prior` the stored one. */
    compare(current: Fingerprint, prior: Fingerprint): Comparison {
        const sequenceRatio = this.sequenceRatio(current.normalized, prior.normalized, prior.seqIndex);
        const jaccard = this.jaccard(current.tokens, prior.tokens);
        const charCosine = this.cosine(current.charNgrams, prior.charNgrams, current.charNorm, prior.charNorm);
        const la = current.normalized.length;
        const lb = prior.normalized.length;
        const lengthRatio = la || lb ? Math.max(la, lb) / Math.max(1, Math.min(la, lb)) : 1.0;
        const newContentRatio = this.newContentRatio(current.deltaTokens, prior.deltaTokenSet);
        const confidence = this.computeConfidence(sequenceRatio, charCosine, jaccard);
        return { sequenceRatio, jaccard, charCosine, confidence, lengthRatio, newContentRatio };
    }

    /** Count how many of the three algorithms clear their thresholds. */
    countAlgorithmsTriggered(c: Comparison, t: SimilarityThresholds): number {
        let count = 0;
        if (c.sequenceRatio >= t.sequenceRatioThreshold) count++;
        if (c.charCosine >= t.charCosineThreshold) count++;
        if (c.jaccard >= t.jaccardThreshold) count++;
        return count;
    }

    /** Length-gated weighted-voting decision for a similar (non-exact) pair. */
    meetsSimilarityThresholds(
        current: Fingerprint,
        prior: Fingerprint,
        c: Comparison,
        t: SimilarityThresholds,
    ): boolean {
        const meetsLength =
            current.normalized.length >= t.minNormalizedLength && prior.normalized.length >= t.minNormalizedLength;
        if (!meetsLength || c.lengthRatio > t.lengthRatioThreshold) return false;
        return this.countAlgorithmsTriggered(c, t) >= t.minAlgorithmsToMatch;
    }
}
