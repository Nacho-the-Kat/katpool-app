// When server started
export const serverUptime: Record<number, number> = {};

// Last connect or data
export const lastMinerActivity: Record<number, number> = {};

export function markServerUp(port: number) {
  serverUptime[port] = Date.now();
}

export function updateMinerActivity(port: number) {
  lastMinerActivity[port] = Date.now();
}

export function getServerStatus(port: number, idleMs = 30000): 'dead' | 'idle' | 'active' {
  const startedAt = serverUptime[port];
  const lastActive = lastMinerActivity[port];

  if (typeof startedAt !== 'number') return 'dead';

  // No activity ever
  if (typeof lastActive !== 'number') return 'idle';

  const now = Date.now();

  if (now - lastActive > idleMs) return 'idle';
  return 'active';
}
