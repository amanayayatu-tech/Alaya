import type { KnowledgeItem } from "../core/types.js";

type KnowledgeLike = Pick<KnowledgeItem, "title" | "content"> & {
  semanticKey?: string | null;
};

const TERMS: Array<[string, RegExp]> = [
  ["preview", /dry[- ]?run|预览|可预览|先看到|差异/i],
  ["rollback", /rollback|回滚|可逆|恢复/i],
  ["audit", /audit|审计|追责|可追溯|复盘/i],
  ["risk", /高风险|不可逆|删除|发布|执行/i],
  ["fear", /恐惧|害怕|担心|怕|不敢|fear|afraid/i],
  ["approval", /批准|确认|闸|gate|owner|human/i],
];

function tokens(title: string, content: string): string[] {
  const raw = `${title}\n${content}`;
  const canonical = TERMS.filter(([, re]) => re.test(raw)).map(([term]) => term);
  const words = raw.toLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu, " ").split(/\s+/).filter((term) => term.length >= 3);
  return Array.from(new Set([...canonical, ...words])).sort();
}

export function computeSemanticKey(title: string, content: string): string {
  return tokens(title, content).slice(0, 8).join("|");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

export function isSemanticDuplicate(a: KnowledgeLike, b: KnowledgeLike, threshold = 0.72): boolean {
  if (a.semanticKey && b.semanticKey && a.semanticKey === b.semanticKey) return true;
  return jaccard(new Set(tokens(a.title, a.content)), new Set(tokens(b.title, b.content))) >= threshold;
}

function polarity(text: string): "positive" | "negative" | "neutral" {
  const negative = /不需要|无需|不必|禁止|不得|不能|不应|without|never|must not|do not/i.test(text);
  const positive = /必须|需要|应该|应当|可|允许|must|should|required|need/i.test(text);
  if (negative && positive) return "negative";
  if (negative) return "negative";
  if (positive) return "positive";
  return "neutral";
}

export function isContradiction(a: KnowledgeLike, b: KnowledgeLike): boolean {
  const polarityA = polarity(`${a.title}\n${a.content}`);
  const polarityB = polarity(`${b.title}\n${b.content}`);
  if (polarityA === "neutral" || polarityB === "neutral" || polarityA === polarityB) return false;
  const aTokens = new Set(tokens(a.title, a.content));
  const bTokens = new Set(tokens(b.title, b.content));
  return TERMS.some(([term]) => aTokens.has(term) && bTokens.has(term)) || jaccard(aTokens, bTokens) >= 0.45;
}
