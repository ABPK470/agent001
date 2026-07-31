/**
 * Thread list badge — run count must be accurate before expand.
 *
 * `loadedDisplayRuns === undefined` means not fetched yet → use server count.
 * Never pass a placeholder `[]` for "unknown" — that painted "0 runs".
 * Once loaded (collapsed resume chains), the display list length wins.
 */

export function threadDisplayRunCount(
  serverRunCount: number | undefined,
  loadedDisplayRuns: readonly unknown[] | undefined,
): number {
  if (loadedDisplayRuns !== undefined) return loadedDisplayRuns.length
  return serverRunCount ?? 0
}
