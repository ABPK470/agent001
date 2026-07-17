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
import { C } from "../theme/tokens"

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

/** Returns true if the column header is a primary/foreign key — always a plain integer, never money. */
function isPkHeader(h: string): boolean { return /^pk|^fk|[Ii][Dd]$|_id$/i.test(h) }

/** Returns true if the column header looks like a monetary / large financial value. */
const MONEY_KEYWORDS = /revenue|amount|balance|profit|cost|fee|income|value|zar|usd|eur|gbp|total|sum|price|salary|spend|charge|premium|discount|margin|gross|net|tax|payment|debit|credit|expense|dividend|interest|principal|payout|deposit|withdraw|transfer|payable|receivable|exposure|limit|outstanding|arrears|loss|gain|cashflow|cash_flow|nav|gmv/i
function isMoneyHeader(h: string): boolean { return !isPkHeader(h) && MONEY_KEYWORDS.test(h) }

/** Format a raw numeric string that came from the database into a readable number.
 *  If the absolute value >= 1B, abbreviate (33.19B). Otherwise use comma-thousands + 2dp. */
function formatMoneyCell(raw: string): string {
  const n = numericValue(raw)
  if (isNaN(n)) return raw
  const abs = Math.abs(n)
  const sign = n < 0 ? "−" : ""
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(2)}M`
  // For smaller values just add comma separators
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Format any large unformatted number string for display.
 *
 *  Rules (in order):
 *    1. PK/FK/ID columns → bare integer, no separators (those numbers ARE identifiers, not magnitudes).
 *    2. Already-abbreviated values (12.3M, 4K, …) → pass through.
 *    3. Money columns OR columns containing any decimal value → money formatting
 *       (B/M abbreviation above 1M, otherwise comma-thousands + 2dp).
 *    4. Pure-integer cells in a pure-integer column:
 *       - ≥ 1000 → thousand-separator ("1,234,567") — these are real-world counts, not IDs.
 *       - < 1000 → bare ("42").
 */
function formatNumericCell(raw: string, isMoney: boolean, isPk: boolean, hasDecimals: boolean): string {
  if (!raw || raw === "NULL") return raw
  // PK/FK/ID columns: strip everything non-digit and return bare integer — no separators, no abbreviation
  if (isPk) {
    const n = numericValue(raw)
    return isNaN(n) ? raw : Math.trunc(n).toString()
  }
  // If it already has letters (abbreviated) leave it; commas handled below via numericValue
  if (/[KMBkmb]/.test(raw)) return raw
  if (!isNumericCell(raw)) return raw
  // Money columns OR any decimal-bearing column → money-style formatting.
  if (isMoney || hasDecimals) return formatMoneyCell(raw)
  const n = numericValue(raw)
  if (isNaN(n)) return raw
  // True integers ≥ 1000 → still want thousand separators ("1,234" not "1234").
  if (Number.isInteger(n)) {
    if (Math.abs(n) >= 1000) return n.toLocaleString("en-US")
    return Math.trunc(n).toString()
  }
  // Mixed decimals on a non-money column — show comma-separated, up to 4dp.
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return raw
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

function measureCellWidthHint(value: string): number {
  if (!value) return 0
  const longestLine = value
    .split(/\r?\n/)
    .reduce((max, line) => Math.max(max, line.trim().length), 0)
  return longestLine
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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

  // pk*/fk*/Id columns are always bare integers — never money, never formatted.
  const pkCols = useMemo(
    () => headers.map((h) => isPkHeader(h)),
    [headers],
  )

  // Detect money columns: numeric + header matches money keywords (pk cols excluded).
  const moneyCols = useMemo(
    () => headers.map((h, ci) => !pkCols[ci] && numericCols[ci] && isMoneyHeader(h)),
    [headers, pkCols, numericCols],
  )

  // Detect "has any decimal value" columns — strong signal that the column represents
  // a real-world magnitude (cash, ratio, rate, weight) rather than an identifier or count.
  // Used to apply money-style formatting even when the header doesn't match a money keyword.
  const decimalCols = useMemo(
    () => headers.map((_, ci) =>
      !pkCols[ci] && numericCols[ci] && rows.some((row) => {
        const v = row[ci]
        return !!v && v !== "NULL" && /\.\d/.test(v)
      }),
    ),
    [headers, rows, pkCols, numericCols],
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

  const columnWidths = useMemo(() => {
    if (headers.length === 0) return [] as string[]

    const rawWeights = headers.map((header, ci) => {
      const headerHint = measureCellWidthHint(header)
      const cellHints = pageRows.map((row) => measureCellWidthHint(row[ci] ?? ""))
      const longestValue = cellHints.length > 0 ? Math.max(...cellHints) : 0
      const averageValue = cellHints.length > 0
        ? cellHints.reduce((sum, hint) => sum + hint, 0) / cellHints.length
        : 0

      const baseHint = Math.max(headerHint * 1.15, averageValue * 0.9, longestValue * 0.75)

      if (numericCols[ci] || pkCols[ci]) return clamp(baseHint, 6, 14)

      return clamp(baseHint, 10, 42)
    })

    const totalWeight = rawWeights.reduce((sum, weight) => sum + weight, 0) || headers.length
    return rawWeights.map((weight) => `${(weight / totalWeight) * 100}%`)
  }, [headers, pageRows, numericCols, pkCols])

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
        <span className="text-sm font-mono shrink-0" style={{ color: C.dim }}>
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
            className="bg-transparent outline-none text-sm flex-1"
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
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-sm cursor-pointer transition-colors hover:bg-overlay-2"
          style={{ color: copied ? C.success : C.dim }}
          aria-label="Copy as CSV"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? "Copied" : "CSV"}</span>
        </button>
      </div>

      {/* Table */}
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="text-sm border-collapse" style={{ width: "100%", tableLayout: "fixed" }}>
          <colgroup>
            {columnWidths.map((width, ci) => (
              <col key={ci} style={{ width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr style={{ background: C.elevated }}>
              {headers.map((h, ci) => {
                const isSorted = sort?.col === ci
                const dir = isSorted ? sort!.dir : null
                return (
                  <th
                    key={ci}
                    onClick={() => toggleSort(ci)}
                    className="px-3 py-1.5 font-semibold cursor-pointer select-none transition-colors hover:bg-overlay-2"
                    style={{
                      color: C.text,
                      textAlign: "left",
                      borderBottom: `1px solid ${C.border}`,
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span className="inline-flex items-start gap-1 max-w-full">
                      <span style={{ overflowWrap: "anywhere" }}>{displayHeader(h, ci)}</span>
                      {dir === "asc" ? (
                        <ArrowUp size={14} style={{ color: C.accent }} />
                      ) : dir === "desc" ? (
                        <ArrowDown size={14} style={{ color: C.accent }} />
                      ) : (
                        <ArrowUpDown size={14} style={{ color: C.dim, opacity: 0.5 }} />
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
                    const displayVal = formatNumericCell(val, moneyCols[ci], pkCols[ci], decimalCols[ci])
                    return (
                      <td
                        key={ci}
                        className="px-3 py-1 align-top"
                        style={{
                          color: isNull ? C.dim : numericCols[ci] ? C.peach : C.textSecondary,
                          textAlign: "left",
                          fontFamily: numericCols[ci] ? "monospace" : undefined,
                          fontVariantNumeric: numericCols[ci] ? "tabular-nums" : undefined,
                          borderBottom: `1px solid rgba(255,255,255,0.04)`,
                          whiteSpace: numericCols[ci] ? "nowrap" : "pre-wrap",
                          overflowWrap: "anywhere",
                          wordBreak: "break-word",
                          verticalAlign: "top",
                        }}
                      >
                        {isNull ? (
                          <span style={{ opacity: 0.5 }}>NULL</span>
                        ) : (
                          displayCell(displayVal, ci)
                        )}
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
            <span className="text-sm" style={{ color: C.dim }}>Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}
              className="bg-transparent outline-none text-sm cursor-pointer rounded px-1 py-0.5"
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
            <span className="text-sm font-mono" style={{ color: C.dim }}>
              {total === 0
                ? "0 of 0"
                : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
            </span>
            {!showAll && pageCount > 1 && (
              <div className="flex items-center gap-0.5">
                <PagerBtn disabled={page === 0} onClick={() => setPage(0)} aria="First page"><ChevronsLeft size={16} /></PagerBtn>
                <PagerBtn disabled={page === 0} onClick={() => setPage(page - 1)} aria="Previous page"><ChevronLeft size={16} /></PagerBtn>
                <span className="text-sm font-mono px-1" style={{ color: C.textSecondary }}>
                  {page + 1} / {pageCount}
                </span>
                <PagerBtn disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria="Next page"><ChevronRight size={16} /></PagerBtn>
                <PagerBtn disabled={page >= pageCount - 1} onClick={() => setPage(pageCount - 1)} aria="Last page"><ChevronsRight size={16} /></PagerBtn>
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
