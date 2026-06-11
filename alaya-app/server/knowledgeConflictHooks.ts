type KnowledgeConflictDetector = (projectId: string, newItemIds?: string | string[]) => void;

let conflictDetector: KnowledgeConflictDetector | null = null;

export function setKnowledgeConflictDetector(detector: KnowledgeConflictDetector): void {
  conflictDetector = detector;
}

export function runKnowledgeConflictDetector(projectId: string, newItemIds?: string | string[]): void {
  conflictDetector?.(projectId, newItemIds);
}
