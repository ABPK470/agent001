/**
 * Toolbar view / Space tab neighbors — cycle without opening Summon.
 */

export function neighborViewId(
  views: readonly { id: string }[],
  activeViewId: string,
  direction: -1 | 1,
): string | null {
  if (views.length < 2) return null
  const index = views.findIndex((view) => view.id === activeViewId)
  if (index < 0) return null
  const next = (index + direction + views.length) % views.length
  return views[next]!.id
}
