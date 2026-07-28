/**
 * When chat table Copy / CSV / JSON may be used.
 * Enter-animation "settling" must never disable export — that class stays on
 * after stream end (fill-mode), which used to grey out controls forever.
 */

export function isChatTableExportDisabled(opts: {
  /** False while streaming or mid typewriter reveal. */
  exportSettled: boolean
  /** True only while this table block is still printing mid-reveal. */
  tablePrinting?: boolean
}): boolean {
  if (!opts.exportSettled) return true
  if (opts.tablePrinting) return true
  return false
}
