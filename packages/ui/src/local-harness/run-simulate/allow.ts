/**
 * Local laptop opt-in only. Never on by Vite DEV alone.
 * Delete `packages/ui/src/local-harness/` to remove this harness entirely.
 */

export function isLocalRunSimulateUiEnabled(): boolean {
  return import.meta.env.DEV === true && import.meta.env.VITE_LOCAL_RUN_SIMULATE === "1"
}
