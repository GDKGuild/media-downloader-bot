const cancelFlags = new Map<string, boolean>();
let globalCancel = false;

export function setCancel(channelId: string): void {
  cancelFlags.set(channelId, true);
}

export function setGlobalCancel(): void {
  globalCancel = true;
}

export function isCancelled(channelId: string): boolean {
  return globalCancel || cancelFlags.get(channelId) === true;
}

export function resetCancel(channelId: string): void {
  cancelFlags.delete(channelId);
}

export function resetGlobalCancel(): void {
  globalCancel = false;
}
