import { useSyncExternalStore } from "react";
import type { ChangedFile } from "../shared/contracts";

export interface DiffSelection {
  branch: string;
  parent: string;
  file: ChangedFile;
}

// Panels take no parameters, so the stack panel leaves the file to show here for the diff panel.
const selections = new Map<string, DiffSelection>();
const listeners = new Set<() => void>();
let openDiffPanel: ((workspaceId: string) => void) | null = null;

export function setDiffPanelOpener(opener: ((workspaceId: string) => void) | null): void {
  openDiffPanel = opener;
}

export function showDiff(workspaceId: string, selection: DiffSelection): void {
  selections.set(workspaceId, selection);
  for (const listener of listeners) listener();
  openDiffPanel?.(workspaceId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDiffSelection(workspaceId: string): DiffSelection | null {
  return useSyncExternalStore(subscribe, () => selections.get(workspaceId) ?? null);
}
