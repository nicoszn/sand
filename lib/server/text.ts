/**
 * Tokenisation shared by the retrieval index, the relation graph and the
 * retention model. Kept in its own module so memory.ts and memoryGraph.ts can
 * both use it without a circular import.
 */

const STOPWORDS = new Set(
  "a an the and or but if then than that this these those for from with without into onto over under about after before between of to in on at by is are was were be been being do does did done have has had it its as not no you your we our they their them he she his her i me my what which who whom how why when where all any each more most some such only own same so too very can will just should now also".split(
    " "
  )
);

/** Lower-cased content terms, deduplicated. Stopwords and bare numbers are
 * dropped: "the" and "2025" match everything. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}

/** Longer terms carry more meaning, so relation edges are built from these. */
export function salientTerms(text: string): string[] {
  return terms(text).filter((term) => term.length >= 4);
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const term of A) if (B.has(term)) shared++;
  return shared / (A.size + B.size - shared);
}
