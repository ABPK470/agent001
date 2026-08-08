/**
 * Scroll a row into view inside the drawer list only.
 * Never use Element.scrollIntoView here — it walks overflow ancestors and
 * can jerk the Trace split/host mid open transition (feels like a spring).
 */
export function scrollScopeDrawerRowIntoList(
  list: HTMLElement,
  row: HTMLElement,
): void {
  const listRect = list.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  if (rowRect.top < listRect.top) {
    list.scrollTop -= listRect.top - rowRect.top
    return
  }
  if (rowRect.bottom > listRect.bottom) {
    list.scrollTop += rowRect.bottom - listRect.bottom
  }
}
