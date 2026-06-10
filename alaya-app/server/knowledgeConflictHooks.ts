type KnowledgeConflictDetector = (projectId: string) => void;

let conflictDetector: KnowledgeConflictDetector | null = null;

export function setKnowledgeConflictDetector(detector: KnowledgeConflictDetector): void {
  conflictDetector = detector;
}

export function runKnowledgeConflictDetector(projectId: string): void {
  conflictDetector?.(projectId);
}
