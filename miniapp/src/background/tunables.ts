import {DEFAULT_TUNABLES, TUNABLE_LIMITS, type TunableName} from "../shared/serverContract"

let current: Record<TunableName, number> = {...DEFAULT_TUNABLES}

/** The live value; the server's if it sent a valid one, otherwise the built-in default. */
export function tunable(name: TunableName): number {
  return current[name]
}

/**
 * Takes what the server sent. Unknown names and out-of-range values are
 * ignored one by one, so a bad entry cannot take down the rest.
 */
export function applyTunables(incoming: Record<string, unknown> | undefined): TunableName[] {
  const next: Record<TunableName, number> = {...DEFAULT_TUNABLES}
  const applied: TunableName[] = []
  for (const [name, value] of Object.entries(incoming ?? {})) {
    const limits = TUNABLE_LIMITS[name]
    if (!limits || !(name in DEFAULT_TUNABLES)) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value < limits[0] || value > limits[1]) continue
    next[name as TunableName] = value
    applied.push(name as TunableName)
  }
  current = next
  return applied
}

export function resetTunables(): void {
  current = {...DEFAULT_TUNABLES}
}
