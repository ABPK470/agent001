/**
 * DataTable — lightweight, dependency-free data table for tabular data in chat.
 *
 * Features:
 *   - Sortable columns (click header to cycle asc → desc → none)
 *   - Global text filter (single search box, case-insensitive)
 *   - Pagination with selectable page size (10 / 25 / 50 / 100 / All)
 *   - Auto-detects numeric columns → right-aligned + numeric sort
 *   - Sticky header, dark theme, copy-as-CSV button
 *   - Handles thousands of rows comfortably (sort + filter on raw arrays;
 *     virtualization not required for typical UI ranges, only ~pageSize DOM rows
 *     are rendered at any time)
 *
 * Accepts pre-parsed { headers, rows } so the same component can be fed by:
 *   - Markdown table parser (SmartAnswer)
 *   - Pipe-delimited tool result parser (CodeBlock / parsePipeTable)
 *   - Future: JSON arrays of objects, CSV, etc.
 */

import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Search, X } from "lucide-react"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { C } from "../widgets/ioe/constants"

// ── Types ────────────────────────────────────────────────────────

export interface DataTableProps {
  headers: string[]
  rows: string[][]
  /** Optional row-count hint shown in header (e.g. server-reported "1655 rows"). */
  totalRowsHint?: number | null
  /** Optional truncation indicator when only a partial preview is loaded. */
  truncated?: boolean
  /** Default page size (default 10). */
  defaultPageSize?: number
  /** Optional max table viewport height in px (default 360). */
  maxHeight?: number
  /** Optional column-renderer (e.g. wrap cell in InlineText). Defaults to plain text. */
  renderCell?: (value: string, columnIndex: number) => ReactNode
  /** Optional column-header renderer (defaults to plain text). */
  renderHeader?: (value: string, columnIndex: number) => ReactNode
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, -1] as const // -1 = "All"

// ── Helpers ──────────────────────────────────────────────────────

function isNumericCell(val: string): boolean {
  if (!val || val === "NULL") return false
  const stripped = val.replace(/[,%$€£¥\s]/g, "")
  return stripped !== "" && !isNaN(Number(stripped))
}

function numericValue(val: string): number {
  const stripped = val.replace(/[,%$€£¥\s]/g, "")
  return Number(stripped)
}

function escapeCsvCell(v: string): string {
  if (v.includes(",") || v.includes("\"") || v.includes("\n")) {
    return `"${v.replace(/"/g, "\"\"")}"`
  }
  return v
}

function rowsToCsv(headers: string[], rows: string[][]): string {
  return [headers.map(escapeCsvCell).join(","), ...rows.map((r) => r.map(escapeCsvCell).join(","))].join("\n")
}

// ── Component ────────────────────────────────────────────────────

type SortState = { col: number; dir: "asc" | "desc" } | null

export function DataTable({
  headers,
  rows,
  totalRowsHint = null,
  truncated = false,
  defaultPageSize = 10,
  maxHeight = 360,
  renderCell,
  renderHeader,
}: DataTableProps) {
  const [sort, setSort] = useState<SortState>(null)
  const [filter, setFilter] = useState("")
  const [pageSize, setPageSize] = useState<number>(defaultPageSize)
  const [page, setPage] = useState(0)
  const [copied, setCopied] = useState(false)

  // Detect numeric columns once per (headers, rows) identity
  const numericCols = useMemo(
    () => headers.map((_, ci) => rows.length > 0 && rows.every((row) => !row[ci] || isNumericCell(row[ci]))),
    [headers, rows],
  )

  // Filter
  const filtered = useMemo(() => {
    if (!filter.trim()) return rows
    const needle = filter.toLowerCase()
    return rows.filter((r) => r.some((c) => c && c.toLowerCase().includes(needle)))
  }, [rows, filter])

  // Sort
  const sorted = useMemo(() => {
    if (!sort) return filtered
    const { col, dir } = sort
    const isNum = numericCols[col]
    const sign = dir === "asc" ? 1 : -1
    const copy = filtered.slice()
    copy.sort((a, b) => {
      const av = a[col] ?? ""
      const bv = b[col] ?? ""
      if (av === bv) return 0
      if (av === "" || av === "NULL") return 1 // NULLs last
      if (bv === "" || bv === "NULL") return -1
      if (isNum) return sign * (numericValue(av) - numericValue(bv))
      return sign * av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" })
    })
    return copy
  }, [filtered, sort, numericCols])

  // Pagination
  const total = sorted.length
  const showAll = pageSize === -1
  const effectivePageSize = showAll ? Math.max(total, 1) : pageSize
  const pageCount = showAll ? 1 : Math.max(1, Math.ceil(total / effectivePageSize))
  // Clamp page when filter/sort changes the total
  useEffect(() => {
    if (page > pageCount - 1) setPage(0)
  }, [page, pageCount])
  const start = showAll ? 0 : page * effectivePageSize
  const end = showAll ? total : Math.min(total, start + effectivePageSize)
  const pageRows = useMemo(() => sorted.slice(start, end), [sorted, start, end])

  function toggleSort(col: number) {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" }
      if (prev.dir === "asc") return { col, dir: "desc" }
      return null
    })
  }

  function copyCsv() {
    const csv = rowsToCsv(headers, sorted)
    navigator.clipboard.writeText(csv).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const displayCell = renderCell ?? ((v: string) => v)
  const displayHeader = renderHeader ?? ((v: string) => v)

  const headerCount = totalRowsHint ?? rows.length
  const showFooterControls = total > 10 || pageSize !== defaultPageSize || filter !== ""

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}`, background: C.base }}>
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-2 py-1.5 flex-wrap"
        style={{ background: C.elevated, borderBottom: `1px solid ${C.border}` }}
      >
        <span className="text-[11px] font-mono shrink-0" style={{ color: C.dim }}>
          {filter
            ? `${total.toLocaleString()} of ${headerCount.toLocaleString()} row${headerCount !== 1 ? "s" : ""}`
            : `${headerCount.toLocaleString()} row${headerCount !== 1 ? "s" : ""}`}
          {truncated ? " (preview)" : ""}
        </span>
        {/* Filter */}
        <div
          className="flex items-center gap-1 px-1.5 py-0.5 rounded ml-auto"
          style={{ background: C.base, border: `1px solid ${C.border}`, minWidth: 160 }}
        >
          <Search size={11} style={{ color: C.dim }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => { setFilter(e.target.value); setPage(0) }}
            placeholder="Filter…"
            className="bg-transparent outline-none text-[11px] flex-1"
            style={{ color: C.text, minWidth: 0 }}
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="cursor-pointer"
              style={{ color: C.dim }}
              aria-label="Clear filter"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={copyCsv}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] cursor-pointer transition-colors hover:bg-white/5"
          style={{ color: copied ? C.success : C.dim }}
          aria-label="Copy as CSV"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? "Copied" : "CSV"}</span>
        </button>
      </div>

      {/* Table */}
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="text-[12px] border-collapse" style={{ width: "max-content", minWidth: "100%" }}>
          <thead className="sticky top-0 z-10">
            <tr style={{ background: C.elevated }}>
              {headers.map((h, ci) => {
                const isSorted = sort?.col === ci
                const dir = isSorted ? sort!.dir : null
                return (
                  <th
                    key={ci}
                    onClick={() => toggleSort(ci)}
                    className="px-3 py-1.5 font-semibold whitespace-nowrap cursor-pointer select-none transition-colors hover:bg-white/5"
                    style={{
                      color: C.text,
                      textAlign: numericCols[ci] ? "right" : "left",
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    <span className="inline-flex items-center gap-1" style={{ flexDirection: numericCols[ci] ? "row-reverse" : "row" }}>
                      <span>{displayHeader(h, ci)}</span>
                      {dir === "asc" ? (
                        <ArrowUp size={10} style={{ color: C.accent }} />
                      ) : dir === "desc" ? (
                        <ArrowDown size={10} style={{ color: C.accent }} />
                      ) : (
                        <ArrowUpDown size={10} style={{ color: C.dim, opacity: 0.5 }} />
                      )}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length}
                  className="px-3 py-6 text-center"
                  style={{ color: C.dim }}
                >
                  {filter ? "No rows match the filter." : "(no rows)"}
                </td>
              </tr>
            ) : (
              pageRows.map((row, ri) => (
                <tr
                  key={ri}
                  style={{ background: ri % 2 !== 0 ? "rgba(255,255,255,0.015)" : "transparent" }}
                >
                  {headers.map((_, ci) => {
                    const val = row[ci] ?? ""
                    const isNull = val === "NULL"
                    return (
                      <td
                        key={ci}
                        className="px-3 py-1"
                        style={{
                          color: isNull ? C.dim : numericCols[ci] ? C.peach : C.textSecondary,
                          textAlign: numericCols[ci] ? "right" : "left",
                          fontFamily: numericCols[ci] ? "monospace" : undefined,
                          fontVariantNumeric: numericCols[ci] ? "tabular-nums" : undefined,
                          borderBottom: `1px solid rgba(255,255,255,0.04)`,
                          whiteSpace: "nowrap",
                          maxWidth: 480,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={val.length > 60 ? val : undefined}
                      >
                        {isNull ? <span style={{ opacity: 0.5 }}>NULL</span> : displayCell(val, ci)}
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer controls */}
      {showFooterControls && (
        <div
          className="flex items-center justify-between gap-2 px-2 py-1 flex-wrap"
          style={{ background: C.elevated, borderTop: `1px solid ${C.border}` }}
        >
          <div className="flex items-center gap-1">
            <span className="text-[11px]" style={{ color: C.dim }}>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}
              className="bg-transparent outline-none text-[11px] cursor-pointer rounded px-1 py-0.5"
              style={{ color: C.textSecondary, border: `1px solid ${C.border}` }}
            >
              {PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={opt} style={{ background: C.base }}>
                  {opt === -1 ? "All" : opt}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono" style={{ color: C.dim }}>
              {total === 0
                ? "0 of 0"
                : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
            </span>
            {!showAll && pageCount > 1 && (
              <div className="flex items-center gap-0.5">
                <PagerBtn disabled={page === 0} onClick={() => setPage(0)} aria="First page"><ChevronsLeft size={12} /></PagerBtn>
                <PagerBtn disabled={page === 0} onClick={() => setPage(page - 1)} aria="Previous page"><ChevronLeft size={12} /></PagerBtn>
                <span className="text-[11px] font-mono px-1" style={{ color: C.textSecondary }}>
                  {page + 1} / {pageCount}
                </span>
                <PagerBtn disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria="Next page"><ChevronRight size={12} /></PagerBtn>
                <PagerBtn disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)} aria="Last page"><ChevronsRight size={12} /></PagerBtn>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PagerBtn({ disabled, onClick, children, aria }: { disabled: boolean; onClick: () => void; children: ReactNode; aria: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={aria}
      className="p-1 rounded transition-colors"
      style={{
        color: disabled ? C.dim : C.textSecondary,
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
        background: "transparent",
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)" }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent" }}
    >
      {children}
    </button>
  )
}
