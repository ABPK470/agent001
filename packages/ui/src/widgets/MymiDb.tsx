/**
 * MymiDb — enterprise database explorer for the mymi MSSQL database.
 *
 * Features:
 *  - Global cross-schema search (objects + columns)
 *  - Schema sidebar with size bars and row stats
 *  - Object list with relative size fill bars, row counts, column counts
 *  - Detail panel with 3 tabs: Preview | Columns | Relations
 *  - FK relation graph (text-based, inbound + outbound)
 *  - Live preview of table contents (limit 100 rows)
 */

import {
    ChevronRight,
    Database,
    Download,
    Eye,
    Key,
    Layers,
    LayoutList,
    Link2,
    Loader2,
    Network,
    RefreshCw,
    Search,
    Table2,
    X
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { Listbox, type ListboxOption } from "../components/Listbox"
import { ToastStack, useWidgetToasts } from "../hooks/useWidgetToasts"
import { useContainerSize } from "../hooks/useContainerSize"

// ── Types ────────────────────────────────────────────────────────

type DbConfig  = { name: string; server: string; database: string; writeEnabled: boolean }
type SchemaStat = { schema: string; tableCount: number; viewCount: number; totalRows: number; totalMb: number }
type SchemaInfo = { name: string; tableCount: number; viewCount: number }
type DbObject  = { name: string; type: "table" | "view"; rowCount: number; sizeMb: number; columnCount: number }
type ColDef    = {
  ordinal: number; name: string; dataType: string; typeDetail: string | null
  nullable: boolean; identity: boolean; computed: boolean; isPk: boolean
  fkSchema: string | null; fkTable: string | null; fkColumn: string | null
  description: string | null
}
type RelData = {
  outbound: Array<{ constraintName: string; localColumn: string; refSchema: string; refTable: string; refColumn: string; refRowCount: number }>
  inbound:  Array<{ constraintName: string; srcSchema: string; srcTable: string; srcColumn: string; localColumn: string; srcRowCount: number }>
  implicit: Array<{ column: string; dataType: string; tables: Array<{ qualifiedName: string; rowCount: number | null }> }>
}
type PreviewData = { columns: Array<{ name: string; type: string }>; rows: Record<string, unknown>[] }
type SearchResult = {
  schema: string; name: string; type: "table" | "view"
  rowCount: number; matchKind: "object" | "column"
  columnName: string | null; columnType: string | null
}

type DetailTab = "preview" | "columns" | "relations"

type ModelObject = {
  schema: string; name: string; isTable: boolean
  rowCount: number; sizeMb: number; columnCount: number
  fkOut: number; fkIn: number
  category: string
}
type ModelRelation = { srcSchema: string; srcTable: string; refSchema: string; refTable: string }

// ── Helpers ──────────────────────────────────────────────────────

const SCHEMA_CATEGORY_COLORS: Record<string, string> = {
  Dimension: "text-datatype-int",
  Fact: "text-datatype-bool",
  List: "text-datatype-real",
  Publish: "text-datatype-string",
  "Mapping View": "text-datatype-string",
  "Persisted View": "text-datatype-bin",
  Core: "text-datatype-date",
  External: "text-error",
  Staging: "text-text-muted",
  Hadoop: "text-warning",
  ETL: "text-success",
  QVD: "text-datatype-bin",
  Table: "text-text",
  View: "text-text-muted",
}

const SCHEMA_DISPLAY_NAMES: Record<string, string> = {
  dim: "Dimension", fact: "Fact", list: "List",
  publish: "Publish", persistedView: "Persisted View",
  map: "Mapping", core: "Core", ext: "External",
  gate: "Staging", gateArchive: "Staging Archive",
  hdfs: "Hadoop", master: "Master", log: "Log",
  etl: "ETL", qvd: "QVD",
}

function classifyObject(schema: string, name: string, isTable: boolean): string {
  if (schema === "dim")           return "Dimension"
  if (schema === "fact")          return "Fact"
  if (schema === "list")          return "List"
  if (schema === "persistedView") return "Persisted View"
  if (schema === "publish") {
    if (/^mapping/i.test(name))   return "Mapping View"
    return "Publish"
  }
  if (schema === "map")           return "Mapping View"
  if (schema === "core")          return "Core"
  if (schema === "ext")           return "External"
  if (schema === "gate" || schema === "gateArchive") return "Staging"
  if (schema === "hdfs")          return "Hadoop"
  if (schema === "log")           return "Log"
  if (schema === "etl")           return "ETL"
  if (schema === "qvd")           return "QVD"
  return isTable ? "Table" : "View"
}

function fmtRows(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Safely truncate a string that may be null/undefined. Always returns a string. */
function truncStr(s: string | null | undefined, max: number, fallback = "—"): string {
  if (s == null) return fallback
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

function fmtMb(n: number): string {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
  if (n > 0)     return `${n.toFixed(1)} MB`
  return "–"
}

function typeColor(dt: string): string {
  if (/int|bigint|smallint|tinyint/.test(dt)) return "text-datatype-int"
  if (/decimal|numeric|float|real|money/.test(dt)) return "text-datatype-real"
  if (/char|text|xml|json/.test(dt)) return "text-datatype-string"
  if (/date|time/.test(dt)) return "text-datatype-date"
  if (/bit|bool/.test(dt)) return "text-datatype-bool"
  return "text-text-muted"
}

function useDebounce<T>(val: T, ms: number): T {
  const [deb, setDeb] = useState(val)
  useEffect(() => {
    const t = setTimeout(() => setDeb(val), ms)
    return () => clearTimeout(t)
  }, [val, ms])
  return deb
}

// ── Size bar ─────────────────────────────────────────────────────

function SizeBar({ value, max, className = "" }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div className={`absolute left-0 top-0 h-full bg-accent/8 pointer-events-none transition-all ${className}`}
      style={{ width: `${pct}%` }} />
  )
}

// ── Main component ───────────────────────────────────────────────

export function MymiDb() {
  const { toasts, dismissToast, notifyError } = useWidgetToasts()
  // ── Top-level mode ───────────────────────────────────────────
  const [topMode, setTopMode] = useState<"explorer" | "datamodel">("explorer")

  // ── DB / schema state ────────────────────────────────────────
  const [databases, setDatabases]       = useState<DbConfig[]>([])
  const [activeDb, setActiveDb]         = useState<string | undefined>(undefined)
  const [stats, setStats]               = useState<SchemaStat[]>([])
  const [schemas, setSchemas]           = useState<SchemaInfo[]>([])
  const [schemasLoading, setSchemasLoading] = useState(false)
  const [activeSchema, setActiveSchema] = useState<string | null>(null)

  // ── Object list state ────────────────────────────────────────
  const [objects, setObjects]           = useState<DbObject[]>([])
  const [objectsLoading, setObjectsLoading] = useState(false)
  const [objectFilter, setObjectFilter] = useState("")
  const [objectSort, setObjectSort]     = useState<"name" | "rows">("name")
  const [typeFilter, setTypeFilter]     = useState<"all" | "table" | "view">("all")

  // ── Selected object + detail ─────────────────────────────────
  const [activeObject, setActiveObject] = useState<DbObject | null>(null)
  const [activeTab, setActiveTab]       = useState<DetailTab>("preview")

  // ── Detail data ──────────────────────────────────────────────
  const [preview, setPreview]           = useState<PreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const [columns, setColumns]           = useState<ColDef[]>([])
  const [columnsLoading, setColumnsLoading] = useState(false)
  const [colFilter, setColFilter]       = useState("")

  const [relations, setRelations]       = useState<RelData | null>(null)
  const [relLoading, setRelLoading]     = useState(false)
  const [relViewMode, setRelViewMode]   = useState<"list" | "visual">("visual")

  // ── Search state ─────────────────────────────────────────────
  const [searchQuery, setSearchQuery]   = useState("")
  const [searchSchemas, setSearchSchemas] = useState<Set<string>>(new Set())
  const debouncedSearch = useDebounce(searchQuery, 350)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 700
  const narrow  = rootWidth > 0 && rootWidth < 520
  const isSearchMode = debouncedSearch.length >= 2

  // ── Bootstrap ────────────────────────────────────────────────
  useEffect(() => {
    api.mymiListDatabases().then((dbs) => {
      setDatabases(dbs)
      if (dbs.length > 0) setActiveDb(dbs[0].name)
    }).catch(() => {})
  }, [])

  const loadSchemas = useCallback(async (db?: string) => {
    setSchemasLoading(true)
    setActiveSchema(null)
    setObjects([])
    setActiveObject(null)
    setStats([])
    try {
      const [s, o] = await Promise.all([
        api.mymiListSchemas(db),
        api.mymiOverview(db),
      ])
      setSchemas(Array.isArray(s) ? s : [])
      setStats(Array.isArray(o) ? o : [])
    } catch (e) {
      notifyError(e instanceof Error ? e.message : "Failed to load schemas")
    } finally {
      setSchemasLoading(false)
    }
  }, [notifyError])

  useEffect(() => {
    if (activeDb !== undefined) loadSchemas(activeDb)
  }, [activeDb, loadSchemas])

  // ── Load objects when schema selected ───────────────────────
  useEffect(() => {
    if (!activeSchema) return
    setObjectsLoading(true)
    setObjects([])
    setActiveObject(null)
    setObjectFilter("")
    api.mymiListObjects(activeSchema, activeDb)
      .then((d) => setObjects(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setObjectsLoading(false))
  }, [activeSchema, activeDb])

  // ── Load detail data when object / tab changes ───────────────
  useEffect(() => {
    if (!activeObject || !activeSchema) return
    if (activeTab === "preview") {
      setPreviewLoading(true); setPreview(null)
      api.mymiPreview(activeSchema, activeObject.name, activeDb)
        .then(setPreview)
        .catch((e) => notifyError(e instanceof Error ? e.message : "Failed to load preview"))
        .finally(() => setPreviewLoading(false))
    } else if (activeTab === "columns") {
      setColumnsLoading(true); setColumns([])
      api.mymiColumns(activeSchema, activeObject.name, activeDb)
        .then(setColumns)
        .catch(() => {})
        .finally(() => setColumnsLoading(false))
    } else if (activeTab === "relations") {
      setRelLoading(true); setRelations(null)
      api.mymiRelations(activeSchema, activeObject.name, activeDb)
        .then(setRelations)
        .catch(() => {})
        .finally(() => setRelLoading(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeObject, activeSchema, activeTab, activeDb])

  // ── Search ───────────────────────────────────────────────────
  useEffect(() => {
    if (!isSearchMode) { setSearchResults([]); return }
    setSearchLoading(true)
    api.mymiSearch(debouncedSearch, activeDb, searchSchemas.size > 0 ? [...searchSchemas] : undefined)
      .then(setSearchResults)
      .catch(() => {})
      .finally(() => setSearchLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, activeDb, searchSchemas])

  // ── Derived ──────────────────────────────────────────────────
  const maxSchemaRows = Math.max(...stats.map((s) => s.totalRows ?? 0), 1)
  const maxObjRows    = Math.max(...objects.map((o) => o.rowCount ?? 0), 1)

  const filteredObjects = objects
    .filter((o) =>
      (typeFilter === "all" || o.type === typeFilter) &&
      (!objectFilter || (o.name ?? "").toLowerCase().includes(objectFilter.toLowerCase())),
    )
    .sort((a, b) => objectSort === "rows" ? (b.rowCount ?? 0) - (a.rowCount ?? 0) : (a.name ?? "").localeCompare(b.name ?? ""))

  const filteredCols = colFilter
    ? columns.filter((c) => (c.name ?? "").toLowerCase().includes(colFilter.toLowerCase()))
    : columns

  const activeDbInfo = databases.find((d) => d.name === activeDb)

  function selectObject(schema: string, obj: DbObject) {
    setActiveSchema(schema)
    setActiveObject(obj)
    setActiveTab("preview")
    setSearchQuery("")
  }

  function selectFromSearch(r: SearchResult) {
    const objLike: DbObject = { name: r.name, type: r.type, rowCount: r.rowCount, sizeMb: 0, columnCount: 0 }
    setActiveSchema(r.schema)
    setActiveObject(objLike)
    setActiveTab(r.matchKind === "column" ? "columns" : "preview")
    setSearchQuery("")
  }

  const TABS: Array<{ key: DetailTab; label: string; Icon: React.FC<{ size?: number; className?: string }> }> = [
    { key: "preview",   label: "Preview",   Icon: Table2 },
    { key: "columns",   label: "Columns",   Icon: Layers },
    { key: "relations", label: "Relations", Icon: Link2 },
  ]

  return (
    <div ref={rootRef} className="relative flex flex-col h-full overflow-hidden text-text">

      {/* ── Header (toolbar — title comes from WidgetFrame) ───────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 bg-surface">
        {/* DB selector */}
        {databases.length > 1 && (() => {
          const dbOpts: ListboxOption<string>[] = databases.map((d) => ({
            value: d.name,
            label: d.name.toUpperCase(),
            hint: d.database,
          }))
          return (
            <Listbox
              value={activeDb}
              options={dbOpts}
              onChange={(v) => setActiveDb(v)}
              size="md"
              variant="card"
              ariaLabel="Database"
              className="min-w-[140px]"
            />
          )
        })()}
        {databases.length === 1 && activeDbInfo && (
          <span className="text-sm text-text-muted font-mono">{activeDbInfo.server} / {activeDbInfo.database}</span>
        )}

        {/* Global search */}
        <div className="flex-1 mx-2 relative max-w-lg">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            ref={searchInputRef}
            className="w-full bg-base rounded-lg pl-8 pr-8 py-1.5 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
            placeholder="Search tables, views, columns…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
              onClick={() => setSearchQuery("")}>
              <X size={12} />
            </button>
          )}
        </div>

        <button
          className="p-1 rounded hover:bg-elevated text-text-muted hover:text-text transition-colors"
          title="Refresh"
          onClick={() => loadSchemas(activeDb)}
        >
          <RefreshCw size={13} />
        </button>

        {/* Mode tabs */}
        <div className="flex items-center gap-0.5 ml-1 border-l border-border pl-2">
          {([["explorer", "Explorer"], ["datamodel", "Data Model"]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTopMode(key)}
              className={[
                "px-2 py-1 rounded text-xs transition-colors",
                topMode === key
                  ? "bg-accent/20 text-accent font-medium"
                  : "text-text-muted hover:text-text hover:bg-elevated",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Data Model mode ────────────────────────────────────── */}
      {topMode === "datamodel" && <DataModelView db={activeDb} onNotifyError={notifyError} />}

      {/* ── Explorer mode ──────────────────────────────────────── */}
      {topMode === "explorer" && <>

      {/* ── Search overlay ─────────────────────────────────────── */}
      {isSearchMode && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Schema filter chips */}
          {schemas.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0 flex-wrap">
              <span className="text-[11px] text-text-muted mr-1">Filter:</span>
              {schemas.map((s) => (
                <button
                  key={s.name}
                  onClick={() => {
                    setSearchSchemas((prev) => {
                      const n = new Set(prev)
                      n.has(s.name) ? n.delete(s.name) : n.add(s.name)
                      return n
                    })
                  }}
                  className={[
                    "px-2 py-0.5 rounded text-[11px] font-mono transition-colors",
                    searchSchemas.has(s.name)
                      ? "bg-accent text-white"
                      : "bg-base text-text-muted hover:text-text hover:bg-elevated",
                  ].join(" ")}
                >
                  {s.name}
                </button>
              ))}
              {searchSchemas.size > 0 && (
                <button className="text-[11px] text-text-muted hover:text-error ml-1"
                  onClick={() => setSearchSchemas(new Set())}>
                  clear
                </button>
              )}
            </div>
          )}

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {searchLoading && (
              <div className="flex items-center gap-2 px-4 py-6 text-text-muted text-sm">
                <Loader2 size={14} className="animate-spin" /> Searching…
              </div>
            )}
            {!searchLoading && searchResults.length === 0 && (
              <div className="px-4 py-8 text-text-muted text-sm text-center">
                No results for "{debouncedSearch}"
              </div>
            )}
            {!searchLoading && searchResults.map((r, i) => (
              <button
                key={i}
                className="w-full text-left px-4 py-2.5 hover:bg-elevated/40 flex items-start gap-3 border-b border-border/30 transition-colors"
                onClick={() => selectFromSearch(r)}
              >
                <div className="shrink-0 mt-0.5">
                  {r.type === "view"
                    ? <Eye size={13} className="text-text-muted" />
                    : <Table2 size={13} className="text-text-muted" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted font-mono">{r.schema}.</span>
                    <span className="text-xs font-mono font-semibold text-text">{r.name}</span>
                    {r.matchKind === "column" && r.columnName && (
                      <span className="text-[11px] text-accent">› {r.columnName}
                        {r.columnType && <span className="text-text-muted ml-1">({r.columnType})</span>}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5">
                    {fmtRows(r.rowCount)} rows
                    <span className="opacity-50 mx-1">·</span>
                    {r.matchKind === "object" ? "name match" : "column match"}
                  </div>
                </div>
                <ChevronRight size={12} className="text-text-muted shrink-0 mt-1" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Browse mode ────────────────────────────────────────── */}
      {!isSearchMode && (
        <div className="flex flex-1 overflow-hidden">

          {/* Schema panel */}
          <div className={`${narrow ? "w-24" : "w-[12rem]"} shrink-0 border-r border-border flex flex-col overflow-hidden`}>
            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted border-b border-border/50">
              Schemas
            </div>

            {schemasLoading && (
              <div className="flex items-center gap-2 px-3 py-4 text-text-muted text-xs">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {schemas.map((s) => {
                const stat = stats.find((st) => st.schema === s.name)
                const rowPct = stat ? Math.max(2, (stat.totalRows / maxSchemaRows) * 100) : 0
                return (
                  <button
                    key={s.name}
                    onClick={() => setActiveSchema(s.name)}
                    className={[
                      "relative w-full text-left px-2 py-2 flex flex-col transition-colors overflow-hidden",
                      activeSchema === s.name ? "bg-accent/15" : "hover:bg-elevated/40",
                    ].join(" ")}
                  >
                    {/* size fill */}
                    <div className="absolute left-0 bottom-0 h-0.5 bg-accent/30 transition-all"
                      style={{ width: `${rowPct}%` }} />
                    <div className="flex items-center gap-1">
                      <ChevronRight size={11} className={[
                        "shrink-0 transition-transform text-text-muted",
                        activeSchema === s.name ? "rotate-90 text-accent" : "",
                      ].join(" ")} />
                      <span className={[
                        "text-sm font-mono font-medium truncate",
                        activeSchema === s.name ? "text-accent" : "text-text",
                      ].join(" ")}>{s.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 pl-4 text-[11px] text-text-muted">
                      <span>{s.tableCount}T</span>
                      {s.viewCount > 0 && <span>{s.viewCount}V</span>}
                      {stat && stat.totalRows > 0 && (
                        <span className="ml-auto">{fmtRows(stat.totalRows)}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Object list */}
          <div className={`${narrow ? "w-36" : "w-64"} shrink-0 border-r border-border flex flex-col overflow-hidden`}>
            <div className="px-2 py-2 border-b border-border/50 shrink-0 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-muted truncate">
                  {activeSchema ?? "Objects"}
                </span>
                {objects.length > 0 && (
                  <span className="ml-auto text-[11px] text-text-muted">{objects.length}</span>
                )}
              </div>
              {activeSchema && (
                <div className="flex gap-1">
                  <div className="relative flex-1">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
                    <input
                      className="w-full bg-base rounded pl-6 pr-2 py-1 text-xs text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
                      placeholder="Filter…"
                      value={objectFilter}
                      onChange={(e) => setObjectFilter(e.target.value)}
                    />
                  </div>
                  <select
                    className="bg-base text-xs text-text-muted px-1 rounded border-none outline-none focus:ring-1 focus:ring-accent"
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as "all" | "table" | "view")}
                  >
                    <option value="all">All</option>
                    <option value="table">T</option>
                    <option value="view">V</option>
                  </select>
                  <button
                    className={[
                      "text-[11px] px-1.5 rounded transition-colors",
                      objectSort === "rows"
                        ? "bg-accent/20 text-accent"
                        : "text-text-muted hover:text-text",
                    ].join(" ")}
                    onClick={() => setObjectSort((s) => s === "rows" ? "name" : "rows")}
                    title="Sort by row count"
                  >
                    {objectSort === "rows" ? "#↓" : "A↓"}
                  </button>
                </div>
              )}
            </div>

            {objectsLoading && (
              <div className="flex items-center gap-2 px-3 py-3 text-text-muted text-xs">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            )}

            <div className="flex-1 overflow-y-auto">
              {!activeSchema && !objectsLoading && (
                <div className="px-3 py-4 text-text-muted text-sm">← Select a schema</div>
              )}
              {filteredObjects.map((obj) => {
                const isActive = activeObject?.name === obj.name && activeObject?.type === obj.type
                return (
                  <button
                    key={obj.name}
                    onClick={() => selectObject(activeSchema!, obj)}
                    className={[
                      "relative w-full overflow-hidden text-left px-2 py-1.5 flex items-center gap-1.5 transition-colors",
                      isActive ? "bg-accent/15" : "hover:bg-elevated/40",
                    ].join(" ")}
                  >
                    <SizeBar value={obj.rowCount} max={maxObjRows} />
                    <div className="relative flex items-center gap-1.5 w-full">
                      {obj.type === "view"
                        ? <Eye size={11} className="shrink-0 text-text-muted" />
                        : <Table2 size={11} className="shrink-0 text-text-muted" />}
                      <span className={[
                        "truncate text-xs font-mono",
                        isActive ? "text-accent font-semibold" : "text-text",
                      ].join(" ")}>{obj.name}</span>
                      <span className="ml-auto text-[11px] text-text-muted shrink-0">
                        {obj.type === "table" ? fmtRows(obj.rowCount) : <span className="opacity-50">view</span>}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Detail panel */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {!activeObject && (
              <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3">
                <Database size={32} className="opacity-20" />
                <span className="text-sm">Select a table or view</span>
              </div>
            )}

            {activeObject && (
              <>
                {/* Object header */}
                <div className="px-3 py-2 border-b border-border shrink-0 bg-surface/50">
                  <div className="flex items-center gap-2">
                    {activeObject.type === "view"
                      ? <Eye size={14} className="text-text-muted" />
                      : <Table2 size={14} className="text-text-muted" />}
                    <span className="text-sm font-mono font-semibold text-text">
                      <span className="text-text-muted">{activeSchema}.</span>{activeObject.name}
                    </span>
                    <div className="ml-auto flex items-center gap-3 text-[11px] text-text-muted">
                      {activeObject.rowCount > 0 && (
                        <span className="font-mono">{fmtRows(activeObject.rowCount)} rows</span>
                      )}
                      {activeObject.sizeMb > 0 && (
                        <span className="font-mono">{fmtMb(activeObject.sizeMb)}</span>
                      )}
                      {activeObject.columnCount > 0 && (
                        <span>{activeObject.columnCount} cols</span>
                      )}
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="flex gap-0 mt-2 -mb-[1px]">
                    {TABS.map(({ key, label, Icon }) => (
                      <button
                        key={key}
                        onClick={() => setActiveTab(key)}
                        className={[
                          "flex items-center gap-1.5 px-3 py-1 text-xs border-b-2 transition-colors",
                          activeTab === key
                            ? "border-accent text-accent"
                            : "border-transparent text-text-muted hover:text-text",
                        ].join(" ")}
                      >
                        <Icon size={11} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-hidden flex flex-col">

                  {/* ── Preview tab ─────────────────────────── */}
                  {activeTab === "preview" && (
                    <>
                      {previewLoading && <Spinner />}
                      {preview && !previewLoading && (
                        preview.rows.length === 0
                          ? <Empty msg="No rows" />
                          : (
                            <div className="flex-1 overflow-auto">
                              <table className="w-full text-xs border-collapse min-w-max">
                                <thead>
                                  <tr className="sticky top-0 z-10 bg-surface">
                                    {preview.columns.map((col) => (
                                      <th key={col.name}
                                        title={col.type}
                                        className="text-left px-3 py-1.5 text-text-muted font-semibold border-b border-border whitespace-nowrap">
                                        {col.name}
                                        <span className="text-[10px] font-normal ml-1 opacity-50">{col.type}</span>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {preview.rows.map((row, ri) => (
                                    <tr key={ri} className={ri % 2 === 0 ? "" : "bg-base/30"}>
                                      {preview.columns.map((col) => {
                                        const val = row[col.name]
                                        return (
                                          <td key={col.name}
                                            className="px-3 py-1 border-b border-border/30 text-text whitespace-nowrap max-w-[220px] truncate">
                                            {val == null
                                              ? <span className="text-text-muted italic opacity-50">null</span>
                                              : typeof val === "object"
                                                ? <span className="text-text-muted">{JSON.stringify(val)}</span>
                                                : String(val)}
                                          </td>
                                        )
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )
                      )}
                    </>
                  )}

                  {/* ── Columns tab ──────────────────────────── */}
                  {activeTab === "columns" && (
                    <>
                      {columnsLoading && <Spinner />}
                      {!columnsLoading && columns.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 border-b border-border/50 shrink-0">
                            <input
                              className="w-full max-w-xs bg-base rounded px-2 py-0.5 text-xs text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
                              placeholder="Filter columns…"
                              value={colFilter}
                              onChange={(e) => setColFilter(e.target.value)}
                            />
                          </div>
                          <div className="flex-1 overflow-auto">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="sticky top-0 z-10 bg-surface">
                                  <th className="text-left px-3 py-1.5 text-text-muted font-semibold border-b border-border w-6">#</th>
                                  <th className="text-left px-2 py-1.5 text-text-muted font-semibold border-b border-border">Column</th>
                                  <th className="text-left px-2 py-1.5 text-text-muted font-semibold border-b border-border">Type</th>
                                  <th className="text-center px-2 py-1.5 text-text-muted font-semibold border-b border-border">Null</th>
                                  <th className="text-left px-2 py-1.5 text-text-muted font-semibold border-b border-border">Flags / FK</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredCols.map((col) => (
                                  <tr key={col.ordinal} className="hover:bg-elevated/30 group">
                                    <td className="px-3 py-1 border-b border-border/30 text-text-muted">{col.ordinal}</td>
                                    <td className="px-2 py-1 border-b border-border/30">
                                      <div className="flex items-center gap-1.5">
                                        {col.isPk && <Key size={10} className="text-warning shrink-0" title="Primary key" />}
                                        <span className="font-mono font-medium text-text">{col.name}</span>
                                        {col.fkTable && (
                                          <button
                                            className="text-accent opacity-0 group-hover:opacity-100 transition-opacity"
                                            title={`FK → ${col.fkSchema}.${col.fkTable}.${col.fkColumn}`}
                                            onClick={() => {
                                              const target = objects.find((o) => o.name === col.fkTable!)
                                              if (target && col.fkSchema === activeSchema) {
                                                setActiveObject(target)
                                                setActiveTab("preview")
                                              }
                                            }}
                                          >
                                            <Link2 size={10} />
                                          </button>
                                        )}
                                      </div>
                                      {col.description && (
                                        <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{col.description}</div>
                                      )}
                                    </td>
                                    <td className="px-2 py-1 border-b border-border/30 font-mono">
                                      <span className={typeColor(col.dataType)}>{col.dataType}</span>
                                      {col.typeDetail && (
                                        <span className="text-text-muted">({col.typeDetail})</span>
                                      )}
                                    </td>
                                    <td className="px-2 py-1 border-b border-border/30 text-center">
                                      <span className={col.nullable ? "text-text-muted" : "text-error"}>
                                        {col.nullable ? "Y" : "N"}
                                      </span>
                                    </td>
                                    <td className="px-2 py-1 border-b border-border/30">
                                      <div className="flex flex-wrap gap-1">
                                        {col.identity && <Badge color="blue">IDENTITY</Badge>}
                                        {col.computed && <Badge color="purple">COMPUTED</Badge>}
                                        {col.fkTable && (
                                          <Badge color="accent">
                                            FK → {col.fkSchema}.{col.fkTable}
                                          </Badge>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </>
                  )}

                  {/* ── Relations tab ────────────────────────── */}
                  {activeTab === "relations" && (
                    <>
                      {relLoading && <Spinner />}
                      {!relLoading && relations && (
                        <div className="flex flex-col flex-1 min-h-0">
                          <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-border/30">
                            <button
                              onClick={() => setRelViewMode("visual")}
                              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
                                relViewMode === "visual" ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"
                              }`}
                            >
                              <Network size={11} /> Visual
                            </button>
                            <button
                              onClick={() => setRelViewMode("list")}
                              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
                                relViewMode === "list" ? "bg-accent/20 text-accent" : "text-text-muted hover:text-text"
                              }`}
                            >
                              <LayoutList size={11} /> List
                            </button>
                          </div>
                          {relViewMode === "visual"
                            ? <RelationsGraph
                                relations={relations}
                                centerName={activeObject.name}
                                centerSchema={activeSchema!}
                                onNavigate={(schema, table, rowCount) => {
                                  setActiveSchema(schema)
                                  const found = objects.find((o) => o.name === table)
                                  const obj: DbObject = found ?? { name: table, type: "table", rowCount, sizeMb: 0, columnCount: 0 }
                                  setActiveObject(obj)
                                  setActiveTab("preview")
                                }}
                              />
                            : <RelationsList relations={relations} centerSchema={activeSchema!} centerName={activeObject.name} />
                          }
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </>}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-text-muted text-sm">
      <Loader2 size={14} className="animate-spin" /> Loading…
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-8 text-text-muted text-sm text-center">{msg}</div>
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  const cls: Record<string, string> = {
    blue:   "bg-info-soft text-info",
    purple: "bg-accent-soft text-accent",
    accent: "bg-accent/15 text-accent",
  }
  return (
    <span className={`px-1.5 py-0 rounded text-[10px] font-mono ${cls[color] ?? cls.accent}`}>
      {children}
    </span>
  )
}

// ── RelationsGraph ────────────────────────────────────────────────
// SVG-based visual FK diagram: inbound nodes left, center node, outbound right.

interface RelationsGraphProps {
  relations: RelData
  centerName: string
  centerSchema: string
  onNavigate: (schema: string, table: string, rowCount: number) => void
}

function RelationsGraph({ relations, centerName, centerSchema, onNavigate }: RelationsGraphProps) {
  const BOX_W = 160
  const BOX_H = 52
  const COL_GAP = 100
  const ROW_GAP = 12

  const inNodes  = relations.inbound  ?? []
  const outNodes = relations.outbound ?? []
  const implNodes = relations.implicit ?? []
  const totalIn  = inNodes.length
  const totalOut = outNodes.length
  const totalSides = Math.max(totalIn, totalOut, 1)

  const svgH = Math.max(totalSides * (BOX_H + ROW_GAP) + ROW_GAP, BOX_H + ROW_GAP * 2)
  const svgW = BOX_W * 3 + COL_GAP * 2 + 40
  const centerX = BOX_W + COL_GAP + 20
  const centerY = svgH / 2

  function nodeY(i: number, total: number): number {
    const blockH = total * BOX_H + (total - 1) * ROW_GAP
    return svgH / 2 - blockH / 2 + i * (BOX_H + ROW_GAP)
  }

  const hasFk = totalIn > 0 || totalOut > 0

  return (
    <div className="flex-1 overflow-auto">
      {/* FK graph — only shown when there are FK edges */}
      {hasFk && (
        <div className="p-2">
          <div className="text-[10px] text-text-muted px-2 pb-2 flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-0.5 bg-info/70" />
              References (outbound FK)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-0.5 bg-text-muted/50" />
              Referenced by (inbound FK)
            </span>
            <span className="ml-auto opacity-50">click nodes to navigate</span>
          </div>
      <svg width={svgW} height={svgH} className="font-mono overflow-visible" style={{ minWidth: svgW }}>
        <defs>
          <marker id="arrowOut" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="rgb(96,165,250)" fillOpacity="0.8" />
          </marker>
          <marker id="arrowIn" markerWidth="8" markerHeight="8" refX="2" refY="3" orient="auto-start-reverse">
            <path d="M8,0 L8,6 L0,3 z" fill="rgb(148,163,184)" fillOpacity="0.6" />
          </marker>
        </defs>

        {/* Center node */}
        <rect x={centerX} y={centerY - BOX_H / 2} width={BOX_W} height={BOX_H} rx={8}
          fill="color-mix(in oklab, var(--color-accent) 20%, transparent)" stroke="color-mix(in oklab, var(--color-accent) 60%, transparent)" strokeWidth={1.5} />
        <text x={centerX + BOX_W / 2} y={centerY - 7} textAnchor="middle" fontSize={11}
          fill="var(--color-accent)" fontWeight="600">
          {centerName.length > 18 ? centerName.slice(0, 17) + "…" : centerName}
        </text>
        <text x={centerX + BOX_W / 2} y={centerY + 10} textAnchor="middle" fontSize={9}
          fill="var(--color-text-secondary)">
          {centerSchema}
        </text>

        {/* Outbound — this table → them */}
        {outNodes.map((r, i) => {
          const refSchema = r?.refSchema ?? "?"
          const refTable  = r?.refTable  ?? "—"
          const refCol    = r?.refColumn ?? "—"
          const localCol  = r?.localColumn ?? "—"
          const refRows   = r?.refRowCount ?? 0
          const nx = centerX + BOX_W + COL_GAP
          const ny = nodeY(i, totalOut)
          const sx = centerX + BOX_W, sy = centerY
          const ex = nx, ey = ny + BOX_H / 2
          const mx = (sx + ex) / 2
          return (
            <g key={`out-${i}`} className="cursor-pointer" onClick={() => onNavigate(refSchema, refTable, refRows)}>
              <path d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`}
                fill="none" stroke="rgb(96,165,250)" strokeWidth={1.5} strokeOpacity={0.65} markerEnd="url(#arrowOut)" />
              <rect x={nx} y={ny} width={BOX_W} height={BOX_H} rx={8}
                fill="rgba(96,165,250,0.07)" stroke="rgba(96,165,250,0.35)" strokeWidth={1} />
              <text x={nx + BOX_W / 2} y={ny + 16} textAnchor="middle" fontSize={10} fill="rgb(147,197,253)" fontWeight="500">
                {truncStr(refTable, 18)}
              </text>
              <text x={nx + BOX_W / 2} y={ny + 28} textAnchor="middle" fontSize={8.5} fill="var(--color-text-muted)">
                {refSchema} · {fmtRows(refRows)}
              </text>
              <text x={nx + BOX_W / 2} y={ny + 40} textAnchor="middle" fontSize={8} fill="rgba(96,165,250,0.55)">
                {localCol} → {refCol}
              </text>
            </g>
          )
        })}

        {/* Inbound — they → this table */}
        {inNodes.map((r, i) => {
          const srcSchema = r?.srcSchema ?? "?"
          const srcTable  = r?.srcTable  ?? "—"
          const srcCol    = r?.srcColumn ?? "—"
          const localCol  = r?.localColumn ?? "—"
          const srcRows   = r?.srcRowCount ?? 0
          const nx = 20
          const ny = nodeY(i, totalIn)
          const sx = nx + BOX_W, sy = ny + BOX_H / 2
          const ex = centerX, ey = centerY
          const mx = (sx + ex) / 2
          return (
            <g key={`in-${i}`} className="cursor-pointer" onClick={() => onNavigate(srcSchema, srcTable, srcRows)}>
              <path d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`}
                fill="none" stroke="rgb(148,163,184)" strokeWidth={1.5} strokeOpacity={0.45} markerEnd="url(#arrowIn)" />
              <rect x={nx} y={ny} width={BOX_W} height={BOX_H} rx={8}
                fill="color-mix(in oklab, var(--color-text-muted) 8%, transparent)" stroke="var(--color-border-subtle)" strokeWidth={1} />
              <text x={nx + BOX_W / 2} y={ny + 16} textAnchor="middle" fontSize={10} fill="var(--color-text-secondary)" fontWeight="500">
                {truncStr(srcTable, 18)}
              </text>
              <text x={nx + BOX_W / 2} y={ny + 28} textAnchor="middle" fontSize={8.5} fill="var(--color-text-muted)">
                {srcSchema} · {fmtRows(srcRows)}
              </text>
              <text x={nx + BOX_W / 2} y={ny + 40} textAnchor="middle" fontSize={8} fill="var(--color-text-faint)">
                {srcCol} → {localCol}
              </text>
            </g>
          )
        })}
      </svg>
        </div>
      )}

      {/* No FK but also no implicit = truly isolated */}
      {!hasFk && implNodes.length === 0 && (
        <Empty msg="No relationships found (no FK constraints or shared-column joins)" />
      )}

      {/* Implicit join edges — shared column name + data type */}
      {implNodes.length > 0 && (
        <div className="px-3 pb-3 space-y-2">
          <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider pt-3 pb-1">
            Implicit Joins ({implNodes.length} shared columns)
            <span className="ml-2 font-normal normal-case text-[10px]">tables sharing this column name + type</span>
          </div>
          {implNodes.map((edge, ei) => (
            <div key={edge.column ?? `impl-${ei}`} className="rounded-lg border border-border/40 bg-base/50 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-mono text-xs text-text font-semibold">{edge.column ?? "—"}</span>
                <span className="text-[10px] text-text-muted bg-elevated px-1.5 py-0.5 rounded">{edge.dataType ?? "?"}</span>
                <span className="text-[10px] text-text-muted ml-auto">{(edge.tables ?? []).length} table{(edge.tables ?? []).length !== 1 ? "s" : ""}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {(edge.tables ?? []).slice(0, 20).map((t, ti) => (
                  <span key={t?.qualifiedName ?? `t-${ti}`} className="px-1.5 py-0.5 rounded bg-elevated text-[10px] font-mono text-accent/80">
                    {t?.qualifiedName ?? "—"}
                    {t?.rowCount ? <span className="text-text-muted ml-1">({fmtRows(t.rowCount)})</span> : null}
                  </span>
                ))}
                {(edge.tables ?? []).length > 20 && (
                  <span className="px-1.5 py-0.5 rounded bg-elevated text-[10px] text-text-muted">+{(edge.tables ?? []).length - 20} more</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── RelationsList ─────────────────────────────────────────────────
// Tabular list view of FK inbound/outbound + implicit joins.

function RelationsList({ relations, centerSchema, centerName }: {
  relations: RelData
  centerSchema: string
  centerName: string
}) {
  const center = `${centerSchema}.${centerName}`
  const outbound = relations.outbound ?? []
  const inbound  = relations.inbound  ?? []
  const implicit = relations.implicit ?? []
  const hasOut  = outbound.length > 0
  const hasIn   = inbound.length > 0
  const hasImpl = implicit.length > 0

  if (!hasOut && !hasIn && !hasImpl) {
    return <Empty msg="No relationships found (no FK constraints or shared-column joins)" />
  }

  return (
    <div className="flex-1 overflow-y-auto divide-y divide-border/30">
      {hasOut && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
            Outbound FK ({outbound.length}) — {centerName} references →
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left pb-1 pr-3 font-semibold">Local column</th>
                <th className="text-left pb-1 pr-3 font-semibold">References</th>
                <th className="text-left pb-1 pr-3 font-semibold">Remote column</th>
                <th className="text-left pb-1 font-semibold">Rows</th>
              </tr>
            </thead>
            <tbody>
              {outbound.map((r, i) => (
                <tr key={i} className="border-t border-border/20 hover:bg-elevated/20">
                  <td className="py-1 pr-3 font-mono text-text">{r.localColumn}</td>
                  <td className="py-1 pr-3 font-mono text-accent">{r.refSchema}.{r.refTable}</td>
                  <td className="py-1 pr-3 font-mono text-text-muted">{r.refColumn}</td>
                  <td className="py-1 text-text-muted">{r.refRowCount ? fmtRows(r.refRowCount) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasIn && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
            Inbound FK ({inbound.length}) — tables that reference {centerName}
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left pb-1 pr-3 font-semibold">Source</th>
                <th className="text-left pb-1 pr-3 font-semibold">Source column</th>
                <th className="text-left pb-1 pr-3 font-semibold">→ Local column</th>
                <th className="text-left pb-1 font-semibold">Rows</th>
              </tr>
            </thead>
            <tbody>
              {inbound.map((r, i) => (
                <tr key={i} className="border-t border-border/20 hover:bg-elevated/20">
                  <td className="py-1 pr-3 font-mono text-accent">{r.srcSchema}.{r.srcTable}</td>
                  <td className="py-1 pr-3 font-mono text-text-muted">{r.srcColumn}</td>
                  <td className="py-1 pr-3 font-mono text-text">{r.localColumn}</td>
                  <td className="py-1 text-text-muted">{r.srcRowCount ? fmtRows(r.srcRowCount) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasImpl && (
        <div className="p-3">
          <div className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
            Implicit Joins ({implicit.length} shared columns)
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-text-muted">
                <th className="text-left pb-1 pr-3 font-semibold">Column</th>
                <th className="text-left pb-1 pr-3 font-semibold">Type</th>
                <th className="text-left pb-1 font-semibold">Shared with</th>
              </tr>
            </thead>
            <tbody>
              {implicit.map((edge, i) => (
                <tr key={i} className="border-t border-border/20 hover:bg-elevated/20 align-top">
                  <td className="py-1 pr-3 font-mono text-text">{edge.column ?? "—"}</td>
                  <td className="py-1 pr-3 font-mono text-text-muted">{edge.dataType ?? "?"}</td>
                  <td className="py-1">
                    <div className="flex flex-wrap gap-1">
                      {(edge.tables ?? []).filter((t) => t?.qualifiedName !== center).slice(0, 12).map((t, ti) => (
                        <span key={t?.qualifiedName ?? `t-${ti}`} className="px-1 py-0 rounded bg-elevated text-[10px] font-mono text-accent/80">
                          {t?.qualifiedName ?? "—"}
                        </span>
                      ))}
                      {(edge.tables ?? []).length > 13 && (
                        <span className="text-[10px] text-text-muted">+{(edge.tables ?? []).length - 13} more</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── DataModelView ─────────────────────────────────────────────────

function DataModelView({ db, onNotifyError }: { db?: string; onNotifyError?: (message: string) => void }) {
  const [loading, setLoading]   = useState(true)
  const [raw, setRaw]           = useState<{ objects: Omit<ModelObject, "category">[]; relations: ModelRelation[] } | null>(null)
  const [schemaFilter, setSchemaFilter] = useState<Set<string>>(new Set())
  const [catFilter, setCatFilter]       = useState<Set<string>>(new Set())
  const [search, setSearch]             = useState("")
  const [viewMode, setViewMode]         = useState<"table" | "visual">("table")
  const [sortCol, setSortCol]           = useState<"schema" | "name" | "category" | "rows" | "size" | "cols" | "fkOut" | "fkIn">("schema")
  const [sortDir, setSortDir]           = useState<1 | -1>(1)

  useEffect(() => {
    setLoading(true)
    api.mymiDataModel(db)
      .then((d) => {
        if (d && typeof d === "object" && "error" in d) {
          onNotifyError?.(String((d as Record<string, unknown>).error))
          return
        }
        setRaw(d)
      })
      .catch((e) => onNotifyError?.(String(e)))
      .finally(() => setLoading(false))
  }, [db, onNotifyError])

  const objects = useMemo<ModelObject[]>(() => {
    if (!raw || !Array.isArray(raw.objects)) return []
    return raw.objects.map((o) => ({ ...o, category: classifyObject(o.schema, o.name, o.isTable) }))
  }, [raw])

  const schemas    = useMemo(() => [...new Set(objects.map((o) => o.schema))].sort(), [objects])
  const categories = useMemo(() => [...new Set(objects.map((o) => o.category))].sort(), [objects])

  const filtered = useMemo<ModelObject[]>(() => {
    let list = objects
    if (schemaFilter.size > 0) list = list.filter((o) => schemaFilter.has(o.schema))
    if (catFilter.size > 0)    list = list.filter((o) => catFilter.has(o.category))
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((o) => o.name.toLowerCase().includes(q) || o.schema.toLowerCase().includes(q))
    }
    return [...list].sort((a, b) => {
      const va = sortCol === "schema" ? a.schema : sortCol === "name" ? a.name : sortCol === "category" ? a.category
        : sortCol === "rows" ? a.rowCount : sortCol === "size" ? a.sizeMb
        : sortCol === "cols" ? a.columnCount : sortCol === "fkOut" ? a.fkOut : a.fkIn
      const vb = sortCol === "schema" ? b.schema : sortCol === "name" ? b.name : sortCol === "category" ? b.category
        : sortCol === "rows" ? b.rowCount : sortCol === "size" ? b.sizeMb
        : sortCol === "cols" ? b.columnCount : sortCol === "fkOut" ? b.fkOut : b.fkIn
      if (va < vb) return -1 * sortDir
      if (va > vb) return 1 * sortDir
      return 0
    })
  }, [objects, schemaFilter, catFilter, search, sortCol, sortDir])

  function toggleSchemaFilter(s: string) {
    setSchemaFilter((prev) => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  }
  function toggleCatFilter(c: string) {
    setCatFilter((prev) => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n })
  }
  function toggleSort(col: typeof sortCol) {
    if (sortCol === col) setSortDir((d) => (d === 1 ? -1 : 1))
    else { setSortCol(col); setSortDir(1) }
  }

  function exportCsv() {
    if (!filtered.length) return
    const header = "schema,name,type,category,rowCount,sizeMb,columnCount,fkOut,fkIn"
    const rows = filtered.map((o) =>
      [o.schema, o.name, o.isTable ? "table" : "view", o.category,
        o.isTable ? o.rowCount : "",
        o.isTable ? o.sizeMb : "",
        o.columnCount, o.fkOut, o.fkIn].join(","),
    )
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href = url; a.download = "data-model.csv"; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div className="flex-1 flex items-center justify-center text-text-muted gap-2">
      <Loader2 size={16} className="animate-spin" /> Loading data model…
    </div>
  )
  if (!raw) return (
    <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
      Data model unavailable.
    </div>
  )

  const total = raw.objects.length
  const totalRels = raw.relations.length

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 bg-surface/50">
        <span className="text-[11px] text-text-muted">
          {total.toLocaleString()} objects · {totalRels.toLocaleString()} FK edges
          {(schemaFilter.size > 0 || catFilter.size > 0 || search) && (
            <span className="ml-2 text-accent">· {filtered.length.toLocaleString()} shown</span>
          )}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
          <input
            className="bg-base rounded pl-6 pr-2 py-1 text-[11px] text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent w-40"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex rounded overflow-hidden border border-border text-[11px]">
          {(["table", "visual"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={["px-2.5 py-0.5 capitalize transition-colors",
                viewMode === m ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-elevated"].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] bg-base hover:bg-elevated text-text-muted hover:text-text transition-colors border border-border"
        >
          <Download size={11} /> CSV
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-border shrink-0 overflow-x-auto text-[11px] bg-surface/30">
        <span className="text-text-muted shrink-0 font-medium">Schema:</span>
        {schemas.map((s) => (
          <button
            key={s}
            onClick={() => toggleSchemaFilter(s)}
            className={["px-1.5 py-0.5 rounded font-mono shrink-0 transition-colors",
              schemaFilter.has(s) ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-elevated"].join(" ")}
          >
            {s}
          </button>
        ))}
        {schemaFilter.size > 0 && (
          <button onClick={() => setSchemaFilter(new Set())} className="text-text-muted hover:text-error">✕</button>
        )}
        <span className="text-border shrink-0 mx-1">│</span>
        <span className="text-text-muted shrink-0 font-medium">Type:</span>
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => toggleCatFilter(c)}
            className={["px-1.5 py-0.5 rounded shrink-0 transition-colors",
              catFilter.has(c) ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-elevated"].join(" ")}
          >
            <span className={catFilter.has(c) ? "text-accent" : (SCHEMA_CATEGORY_COLORS[c] ?? "")}>{c}</span>
          </button>
        ))}
        {catFilter.size > 0 && (
          <button onClick={() => setCatFilter(new Set())} className="text-text-muted hover:text-error">✕</button>
        )}
      </div>

      {/* View */}
      {viewMode === "table"
        ? <DataModelTable objects={filtered} sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
        : <DataModelVisual objects={filtered} relations={raw.relations} />}
    </div>
  )
}

// ── DataModelTable ────────────────────────────────────────────────

type DmSortCol = "schema" | "name" | "category" | "rows" | "size" | "cols" | "fkOut" | "fkIn"

function DataModelTable({
  objects, sortCol, sortDir, onSort,
}: {
  objects: ModelObject[]
  sortCol: DmSortCol
  sortDir: 1 | -1
  onSort: (col: DmSortCol) => void
}) {
  function Th({ col, label, right }: { col: DmSortCol; label: string; right?: boolean }) {
    const active = sortCol === col
    return (
      <th
        className={["px-2 py-1.5 text-[11px] font-semibold text-text-muted select-none cursor-pointer hover:text-text whitespace-nowrap",
          right ? "text-right" : ""].join(" ")}
        onClick={() => onSort(col)}
      >
        {label}{active ? (sortDir === 1 ? " ↑" : " ↓") : ""}
      </th>
    )
  }

  if (objects.length === 0) return <Empty msg="No objects match the current filters." />

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-xs font-mono border-collapse min-w-[640px]">
        <thead className="sticky top-0 bg-surface z-10 border-b border-border">
          <tr>
            <Th col="schema"   label="Schema" />
            <Th col="name"     label="Name" />
            <Th col="category" label="Type" />
            <Th col="cols"     label="Cols"   right />
            <Th col="rows"     label="Rows"   right />
            <Th col="size"     label="MB"     right />
            <Th col="fkOut"    label="FK →"   right />
            <Th col="fkIn"     label="← FK"   right />
          </tr>
        </thead>
        <tbody>
          {objects.map((o, i) => (
            <tr key={i} className="border-b border-border/20 hover:bg-elevated/20 transition-colors">
              <td className="px-2 py-1 text-text-muted">{o.schema}</td>
              <td className="px-2 py-1 text-text">{o.name}</td>
              <td className="px-2 py-1">
                <span className={SCHEMA_CATEGORY_COLORS[o.category] ?? "text-text-muted"}>{o.category}</span>
              </td>
              <td className="px-2 py-1 text-right text-text-muted">{o.columnCount || "—"}</td>
              <td className="px-2 py-1 text-right">
                {o.isTable && o.rowCount > 0 ? fmtRows(o.rowCount) : <span className="text-text-muted">—</span>}
              </td>
              <td className="px-2 py-1 text-right">
                {o.isTable && o.sizeMb > 0 ? o.sizeMb.toFixed(1) : <span className="text-text-muted">—</span>}
              </td>
              <td className="px-2 py-1 text-right">
                {o.fkOut > 0 ? <span className="text-info">{o.fkOut}</span> : <span className="text-text-muted">—</span>}
              </td>
              <td className="px-2 py-1 text-right">
                {o.fkIn > 0 ? <span className="text-text-secondary">{o.fkIn}</span> : <span className="text-text-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── DataModelVisual ───────────────────────────────────────────────
// Two levels: schema overview (default) + table-level FK graph.
// All data comes from the in-memory CatalogGraph — zero SQL.

const SCHEMA_BOX_W = 190
const SCHEMA_BOX_H = 72
const GRID_COLS    = 4
const GRID_GAP_X   = 60
const GRID_GAP_Y   = 48

// Table-level layout constants
const TL_W   = 170   // box width
const TL_H   = 36    // box height
const TL_RG  = 6     // row gap between tables in same column
const TL_CG  = 110   // col gap between schema columns
const TL_HH  = 34    // schema header height
const TL_PAD = 18    // outer padding
const TL_MAX = 300   // max tables to render

const DM_COLORS: Record<string, { stroke: string; fill: string; text: string }> = {
  blue:    { stroke: "rgba(96,165,250,0.5)",  fill: "rgba(96,165,250,0.07)",  text: "rgb(147,197,253)" },
  orange:  { stroke: "rgba(251,146,60,0.5)",  fill: "rgba(251,146,60,0.07)",  text: "rgb(253,186,116)" },
  green:   { stroke: "rgba(74,222,128,0.5)",  fill: "rgba(74,222,128,0.07)",  text: "rgb(134,239,172)" },
  purple:  { stroke: "rgba(192,132,252,0.5)", fill: "rgba(192,132,252,0.07)", text: "rgb(216,180,254)" },
  fuchsia: { stroke: "rgba(232,121,249,0.5)", fill: "rgba(232,121,249,0.07)", text: "rgb(240,171,252)" },
  cyan:    { stroke: "rgba(34,211,238,0.5)",  fill: "rgba(34,211,238,0.07)",  text: "rgb(103,232,249)" },
  yellow:  { stroke: "rgba(250,204,21,0.5)",  fill: "rgba(250,204,21,0.07)",  text: "rgb(253,224,71)"  },
  red:     { stroke: "rgba(248,113,113,0.5)", fill: "rgba(248,113,113,0.07)", text: "rgb(252,165,165)" },
  slate:   { stroke: "var(--color-border)", fill: "color-mix(in oklab, var(--color-text-muted) 8%, transparent)", text: "var(--color-text-secondary)" },
  amber:   { stroke: "rgba(251,191,36,0.5)",  fill: "rgba(251,191,36,0.07)",  text: "rgb(252,211,77)"  },
  lime:    { stroke: "rgba(163,230,53,0.5)",  fill: "rgba(163,230,53,0.07)",  text: "rgb(190,242,100)" },
  teal:    { stroke: "rgba(45,212,191,0.5)",  fill: "rgba(45,212,191,0.07)",  text: "rgb(94,234,212)"  },
}

function dmColorKey(objs: ModelObject[]): string {
  const counts = new Map<string, number>()
  for (const o of objs) counts.set(o.category, (counts.get(o.category) ?? 0) + 1)
  let best = "", max = 0
  for (const [cat, cnt] of counts) { if (cnt > max) { max = cnt; best = cat } }
  const m = (SCHEMA_CATEGORY_COLORS[best] ?? "").match(/text-(\w+)-/)
  return m ? m[1] : "slate"
}
function dmStyle(objs: ModelObject[]) {
  return DM_COLORS[dmColorKey(objs)] ?? DM_COLORS.slate
}

// ── TableGraph — table-level FK graph ────────────────────────────
function TableGraph({ objects, relations }: { objects: ModelObject[]; relations: ModelRelation[] }) {
  const truncated = objects.length > TL_MAX
  const shown = useMemo(
    () => (truncated ? [...objects].slice(0, TL_MAX) : objects),
    [objects, truncated],
  )

  // Group by schema; tables before views, then alphabetical
  const bySchema = useMemo(() => {
    const m = new Map<string, ModelObject[]>()
    for (const o of shown) {
      if (!m.has(o.schema)) m.set(o.schema, [])
      m.get(o.schema)!.push(o)
    }
    for (const [, arr] of m) arr.sort((a, b) => {
      if (a.isTable !== b.isTable) return a.isTable ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return m
  }, [shown])

  const schemaList = useMemo(() => [...bySchema.keys()].sort(), [bySchema])

  // Box positions keyed by "schema.table"
  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>()
    schemaList.forEach((s, ci) => {
      const x = TL_PAD + ci * (TL_W + TL_CG)
      const arr = bySchema.get(s)!
      arr.forEach((t, ri) => {
        pos.set(`${s}.${t.name}`, { x, y: TL_PAD + TL_HH + ri * (TL_H + TL_RG) })
      })
    })
    return pos
  }, [schemaList, bySchema])

  const shownKeys = useMemo(
    () => new Set(shown.map((o) => `${o.schema}.${o.name}`)),
    [shown],
  )

  // Only draw edges where both endpoints are visible
  const visRels = useMemo(
    () => relations.filter((r) =>
      shownKeys.has(`${r.srcSchema}.${r.srcTable}`) &&
      shownKeys.has(`${r.refSchema}.${r.refTable}`)
    ),
    [relations, shownKeys],
  )

  // Edge lookup set per table (for highlight)
  const connectedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const r of visRels) {
      s.add(`${r.srcSchema}.${r.srcTable}`)
      s.add(`${r.refSchema}.${r.refTable}`)
    }
    return s
  }, [visRels])

  const maxColH = useMemo(() => {
    let m = TL_PAD * 2 + TL_HH
    for (const [, arr] of bySchema) {
      const h = TL_PAD + TL_HH + arr.length * (TL_H + TL_RG) + TL_PAD
      if (h > m) m = h
    }
    return m
  }, [bySchema])

  if (schemaList.length === 0) return <Empty msg="No objects to display. Adjust filters." />

  const svgW = TL_PAD * 2 + schemaList.length * (TL_W + TL_CG)
  const svgH = maxColH

  return (
    <div className="flex-1 overflow-auto p-2">
      {truncated && (
        <div className="text-[10px] text-warning/80 px-2 pb-1">
          Showing first {TL_MAX} of {objects.length} objects — use schema filter to drill into specific tables.
        </div>
      )}
      <div className="text-[10px] text-text-muted px-2 pb-2 opacity-60">
        Table graph · arrows = FK constraints · {visRels.length} relationships shown
      </div>
      <svg width={svgW} height={svgH} className="overflow-visible font-mono" style={{ minWidth: svgW }}>
        <defs>
          <marker id="tlArrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
            <path d="M0,0 L0,5 L5,2.5 z" fill="var(--color-text-muted)" />
          </marker>
        </defs>

        {/* FK edges — drawn before boxes so boxes sit on top */}
        {visRels.map((r, i) => {
          const src = positions.get(`${r.srcSchema}.${r.srcTable}`)
          const tgt = positions.get(`${r.refSchema}.${r.refTable}`)
          if (!src || !tgt) return null
          const x1 = src.x + TL_W, y1 = src.y + TL_H / 2
          const x2 = tgt.x,        y2 = tgt.y + TL_H / 2
          // same-schema: loop out to the right
          if (r.srcSchema === r.refSchema) {
            const lx = src.x + TL_W + 22
            return (
              <path key={i}
                d={`M ${src.x + TL_W} ${y1} C ${lx} ${y1} ${lx} ${y2} ${tgt.x + TL_W} ${y2}`}
                fill="none" stroke="rgba(96,165,250,0.25)" strokeWidth={1}
                markerEnd="url(#tlArrow)"
              />
            )
          }
          const cp = Math.min(Math.abs(x2 - x1) * 0.45, 90)
          return (
            <path key={i}
              d={`M ${x1} ${y1} C ${x1 + cp} ${y1} ${x2 - cp} ${y2} ${x2} ${y2}`}
              fill="none" stroke="var(--color-border-subtle)" strokeWidth={1}
              markerEnd="url(#tlArrow)"
            />
          )
        })}

        {/* Schema columns */}
        {schemaList.map((s, ci) => {
          const x    = TL_PAD + ci * (TL_W + TL_CG)
          const objs = bySchema.get(s)!
          const st   = dmStyle(objs)
          return (
            <g key={s}>
              {/* Schema header */}
              <rect x={x} y={TL_PAD} width={TL_W} height={TL_HH - 4} rx={5}
                fill={st.fill} stroke={st.stroke} strokeWidth={1.5} />
              <text x={x + TL_W / 2} y={TL_PAD + 14} textAnchor="middle"
                fontSize={11} fontWeight="700" fill={st.text}>{s}
              </text>
              <text x={x + TL_W / 2} y={TL_PAD + 26} textAnchor="middle"
                fontSize={8} fill="var(--color-text-muted)">
                {objs.filter((o) => o.isTable).length}T · {objs.filter((o) => !o.isTable).length}V
              </text>

              {/* Table boxes */}
              {objs.map((t) => {
                const pos      = positions.get(`${s}.${t.name}`)!
                const hasEdge  = connectedKeys.has(`${s}.${t.name}`)
                return (
                  <g key={t.name}>
                    <rect x={pos.x} y={pos.y} width={TL_W} height={TL_H} rx={3}
                      fill={hasEdge ? st.fill : "rgba(15,20,30,0.4)"}
                      stroke={hasEdge ? st.stroke : "rgba(148,163,184,0.15)"}
                      strokeWidth={hasEdge ? 1 : 0.5}
                    />
                    <text x={pos.x + 8} y={pos.y + 14} fontSize={9}
                      fontWeight={hasEdge ? "600" : "400"}
                      fill={hasEdge ? st.text : "rgb(148,163,184)"}>
                      {truncStr(t.name, 23)}
                    </text>
                    <text x={pos.x + 8} y={pos.y + 27} fontSize={7.5} fill="var(--color-text-faint)">
                      {t.isTable ? ((t.rowCount ?? 0) > 0 ? fmtRows(t.rowCount) : "table") : "view"} · {t.columnCount ?? 0}c
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function DataModelVisual({
  objects, relations,
}: {
  objects: ModelObject[]
  relations: ModelRelation[]
}) {
  const [viewLevel, setViewLevel] = useState<"schema" | "table">("schema")

  // Group by schema
  const bySchema = useMemo<Map<string, ModelObject[]>>(() => {
    const m = new Map<string, ModelObject[]>()
    for (const o of objects) {
      if (!m.has(o.schema)) m.set(o.schema, [])
      m.get(o.schema)!.push(o)
    }
    return m
  }, [objects])

  const schemaList = [...bySchema.keys()].sort()

  // Aggregate FK edges between schemas (deduplicated)
  const schemaEdges = useMemo(() => {
    const edgeMap = new Map<string, number>()
    for (const r of relations) {
      if (r.srcSchema === r.refSchema) continue
      if (!bySchema.has(r.srcSchema) || !bySchema.has(r.refSchema)) continue
      const key = `${r.srcSchema}→${r.refSchema}`
      edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1)
    }
    return [...edgeMap.entries()].map(([k, count]) => {
      const [src, ref] = k.split("→")
      return { src, ref, count }
    })
  }, [relations, bySchema])

  if (schemaList.length === 0) return <Empty msg="No objects to display. Adjust filters." />

  // Layout: fixed grid
  const cols  = Math.min(GRID_COLS, schemaList.length)
  const rows  = Math.ceil(schemaList.length / cols)
  const svgW  = cols * SCHEMA_BOX_W + (cols - 1) * GRID_GAP_X + 40
  const svgH  = rows * SCHEMA_BOX_H + (rows - 1) * GRID_GAP_Y + 40

  const positions = new Map<string, { x: number; y: number }>()
  schemaList.forEach((s, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    positions.set(s, {
      x: 20 + col * (SCHEMA_BOX_W + GRID_GAP_X),
      y: 20 + row * (SCHEMA_BOX_H + GRID_GAP_Y),
    })
  })

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Schema / Table toggle */}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border/40 shrink-0 bg-surface/30">
        <span className="text-[10px] text-text-muted">Level:</span>
        {(["schema", "table"] as const).map((lv) => (
          <button key={lv} onClick={() => setViewLevel(lv)}
            className={["px-2 py-0.5 rounded text-[11px] transition-colors capitalize",
              viewLevel === lv ? "bg-accent/20 text-accent" : "text-text-muted hover:bg-elevated"].join(" ")}>
            {lv === "schema" ? "Schemas" : "Tables"}
          </button>
        ))}
        <span className="text-[10px] text-text-muted opacity-50 ml-1">
          {viewLevel === "schema"
            ? `${schemaList.length} schemas · ${schemaEdges.length} cross-schema FK links`
            : `${objects.length} objects · ${relations.length} FK edges`}
        </span>
      </div>

      {/* Content */}
      {viewLevel === "table" ? (
        <TableGraph objects={objects} relations={relations} />
      ) : (
        <div className="flex-1 overflow-auto p-2">
          <div className="text-[10px] text-text-muted px-2 pb-2 opacity-60">
            Schema overview · arrows = FK relationships · numbers = FK count · {schemaEdges.length} cross-schema relationships
          </div>
          <svg width={svgW} height={svgH} className="overflow-visible font-mono" style={{ minWidth: svgW }}>
            <defs>
              <marker id="dmArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L0,6 L6,3 z" fill="var(--color-text-faint)" />
              </marker>
            </defs>

            {/* Edges */}
            {schemaEdges.map((e, i) => {
              const sp = positions.get(e.src)
              const tp = positions.get(e.ref)
              if (!sp || !tp) return null
              const sx = sp.x + SCHEMA_BOX_W / 2, sy = sp.y + SCHEMA_BOX_H / 2
              const tx = tp.x + SCHEMA_BOX_W / 2, ty = tp.y + SCHEMA_BOX_H / 2
              const mx = (sx + tx) / 2, my = (sy + ty) / 2
              return (
                <g key={i}>
                  <path
                    d={`M ${sx} ${sy} Q ${mx + (sy - ty) * 0.15} ${my - (sx - tx) * 0.15} ${tx} ${ty}`}
                    fill="none" stroke="var(--color-border-subtle)" strokeWidth={1}
                    markerEnd="url(#dmArrow)"
                  />
                  <text x={mx} y={my} textAnchor="middle" fontSize={8} fill="var(--color-text-faint)">{e.count}</text>
                </g>
              )
            })}

            {/* Schema boxes */}
            {schemaList.map((s) => {
              const pos  = positions.get(s)!
              const objs = bySchema.get(s) ?? []
              const style = dmStyle(objs)
              const tables = objs.filter((o) => o.isTable).length
              const views  = objs.filter((o) => !o.isTable).length
              const totalMb = objs.reduce((sum, o) => sum + o.sizeMb, 0)
              const dominantCat = objs[0]?.category ?? ""
              const displayName = SCHEMA_DISPLAY_NAMES[s] ?? s
              return (
                <g key={s}>
                  <rect x={pos.x} y={pos.y} width={SCHEMA_BOX_W} height={SCHEMA_BOX_H} rx={8}
                    fill={style.fill} stroke={style.stroke} strokeWidth={1.5} />
                  <text x={pos.x + SCHEMA_BOX_W / 2} y={pos.y + 18} textAnchor="middle"
                    fontSize={12} fontWeight="600" fill={style.text}>
                    {s.length > 16 ? s.slice(0, 15) + "…" : s}
                  </text>
                  <text x={pos.x + SCHEMA_BOX_W / 2} y={pos.y + 31} textAnchor="middle"
                    fontSize={9} fill="var(--color-text-muted)">
                    {displayName !== s ? displayName : ""}
                  </text>
                  <text x={pos.x + SCHEMA_BOX_W / 2} y={pos.y + 47} textAnchor="middle"
                    fontSize={9} fill="var(--color-text-muted)">
                    {tables > 0 ? `${tables}T ` : ""}{views > 0 ? `${views}V` : ""}
                    {totalMb > 0 ? ` · ${totalMb >= 1024 ? (totalMb / 1024).toFixed(1) + " GB" : totalMb.toFixed(0) + " MB"}` : ""}
                  </text>
                  <text x={pos.x + SCHEMA_BOX_W / 2} y={pos.y + 60} textAnchor="middle"
                    fontSize={8} fill="rgba(148,163,184,0.45)">
                    {dominantCat}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}
    </div>
  )
}
