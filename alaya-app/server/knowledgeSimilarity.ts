import type { KnowledgeItem } from "@shared/schema";

type KnowledgeLike = Pick<KnowledgeItem, "title" | "content"> & {
  semanticKey?: string | null;
};

const CANONICAL_TERMS: Array<[string, RegExp]> = [
  ["preview", /dry[- ]?run|预览|可预览|先看到|差异/i],
  ["rollback", /rollback|回滚|可逆|恢复/i],
  ["audit", /audit|审计|追责|可追溯|复盘/i],
  ["risk", /高风险|不可逆|删除|发布|执行/i],
  ["fear", /恐惧|害怕|担心|怕|不敢|uncertain|fear|afraid/i],
  ["approval", /批准|确认|闸|gate|owner|human/i],
  ["feedback", /反馈|用户|访谈|issue|form/i],
  ["automation", /自动化|自动操作|agent|飞轮|scheduler/i],
  ["knowledge", /知识|原则|world model|playbook|认知/i],
  ["metric", /指标|activation|conversion|error|误差/i],
];

const STOP_WORDS = new Set([
  "and", "the", "with", "for", "that", "this", "from", "into", "when",
  "then", "should", "must", "user", "users", "cycle", "goal",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[，。！？；：、“”‘’（）【】]/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string): string {
  return normalizeText(value)
    .replace(/dry-run|dryrun/g, "")
    .replace(/\s+/g, "")
    .replace(/[为给把对将]/g, "");
}

function cjkBigrams(value: string): string[] {
  const chars = Array.from(value.replace(/[^\u4e00-\u9fff]/g, ""));
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.push(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

export function tokenizeForSimilarity(title: string, content: string): string[] {
  const raw = `${title}\n${content}`;
  const normalized = normalizeText(raw);
  const canonical = CANONICAL_TERMS
    .filter(([, re]) => re.test(raw))
    .map(([term]) => term);
  const words = normalized
    .split(/\s+/)
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const grams = cjkBigrams(raw).filter((term) => term.length > 0);
  return Array.from(new Set([...canonical, ...words, ...grams])).sort();
}

export function computeSemanticKey(title: string, content: string): string {
  const tokens = tokenizeForSimilarity(title, content);
  const canonical = tokens.filter((token) => CANONICAL_TERMS.some(([term]) => term === token));
  const selected = (canonical.length >= 2 ? canonical : tokens).slice(0, 8);
  return selected.join("|");
}

function tokenSet(item: KnowledgeLike): Set<string> {
  return new Set(tokenizeForSimilarity(item.title, item.content));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of Array.from(a)) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

export function semanticSimilarity(a: KnowledgeLike, b: KnowledgeLike): number {
  const keyA = a.semanticKey?.trim();
  const keyB = b.semanticKey?.trim();
  if (keyA && keyB && keyA === keyB) return 1;
  const tokensA = tokenSet(a);
  const tokensB = tokenSet(b);
  const jac = jaccard(tokensA, tokensB);
  const canonicalA = new Set(Array.from(tokensA).filter((token) => CANONICAL_TERMS.some(([term]) => term === token)));
  const canonicalB = new Set(Array.from(tokensB).filter((token) => CANONICAL_TERMS.some(([term]) => term === token)));
  const canonicalScore = jaccard(canonicalA, canonicalB);
  return Math.max(jac, canonicalScore * 0.92);
}

export function isSemanticDuplicate(a: KnowledgeLike, b: KnowledgeLike, threshold = 0.72): boolean {
  const keyA = a.semanticKey?.trim();
  const keyB = b.semanticKey?.trim();
  if (keyA && keyB && keyA === keyB) return true;
  const canonicalA = new Set(tokenizeForSimilarity(a.title, a.content).filter((token) => CANONICAL_TERMS.some(([term]) => term === token)));
  const canonicalB = new Set(tokenizeForSimilarity(b.title, b.content).filter((token) => CANONICAL_TERMS.some(([term]) => term === token)));
  const sharedCanonical = Array.from(canonicalA).filter((token) => canonicalB.has(token));
  if (threshold <= 0.6 && sharedCanonical.length >= 2) return true;
  const normalizedA = normalizeText(`${a.title} ${a.content}`);
  const normalizedB = normalizeText(`${b.title} ${b.content}`);
  if (normalizedA && normalizedB && (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))) return true;
  const compactA = compactText(`${a.title} ${a.content}`);
  const compactB = compactText(`${b.title} ${b.content}`);
  if (compactA.length >= 6 && compactB.length >= 6 && (compactA.includes(compactB) || compactB.includes(compactA))) return true;
  if (threshold >= 0.8) {
    return jaccard(tokenSet(a), tokenSet(b)) >= threshold;
  }
  return semanticSimilarity(a, b) >= threshold;
}

function polarity(text: string): "positive" | "negative" | "neutral" {
  const hasNegative = /不需要|无需|不必|禁止|不得|不能|不应|不再需要|without|never|must not|do not/i.test(text);
  const hasPositive = /必须|需要|应该|应当|可|允许|建议|must|should|required|need/i.test(text);
  if (hasNegative && !hasPositive) return "negative";
  if (hasPositive && !hasNegative) return "positive";
  if (hasNegative && hasPositive) return "negative";
  return "neutral";
}

export function isContradiction(a: KnowledgeLike, b: KnowledgeLike): boolean {
  const textA = `${a.title}\n${a.content}`;
  const textB = `${b.title}\n${b.content}`;
  const polarityA = polarity(textA);
  const polarityB = polarity(textB);
  if (polarityA === "neutral" || polarityB === "neutral" || polarityA === polarityB) return false;

  const tokensA = tokenSet(a);
  const tokensB = tokenSet(b);
  const sharedCanonical = CANONICAL_TERMS
    .map(([term]) => term)
    .filter((term) => tokensA.has(term) && tokensB.has(term));
  if (sharedCanonical.length > 0) return true;

  return semanticSimilarity(a, b) >= 0.45;
}
