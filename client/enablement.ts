// The settings screen and the entry's button registrations share this module, so a saved
// project mode can make the buttons re-check without waiting for the periodic refresh.
const listeners = new Set<() => void>();

export function onEnablementChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyEnablementChanged(): void {
  for (const listener of listeners) listener();
}
