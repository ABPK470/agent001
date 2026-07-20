/** Rows shown per Bridge preview page. */
export const PREVIEW_PAGE_SIZE = 10

export type PreviewPageSlice<T> = {
  readonly page: number
  readonly pageCount: number
  readonly start: number
  readonly end: number
  readonly rows: T[]
}

/** Slice preview rows into a 0-based page (clamped). */
export function previewPageSlice<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = PREVIEW_PAGE_SIZE,
): PreviewPageSlice<T> {
  if (rows.length === 0) {
    return { page: 0, pageCount: 1, start: 0, end: 0, rows: [] }
  }
  const pageCount = Math.ceil(rows.length / pageSize)
  const safePage = Math.min(Math.max(0, page), pageCount - 1)
  const start = safePage * pageSize
  const end = Math.min(rows.length, start + pageSize)
  return { page: safePage, pageCount, start, end, rows: rows.slice(start, end) }
}
