/**
 * Registry policy — instance DATA for general runners.
 * Rules must never hardcode product nouns; they read this schema.
 * Adding a ban / dialect / catalog = add a row here.
 */

/** Customer-brand path tokens (ops: variance is data — surfaces use domain nouns). */
export const BRAND_TOKENS = ["mymi", "africaflex"]

/** Build brand path regex from tokens. */
export function brandPathPattern(tokens = BRAND_TOKENS) {
  const body = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return new RegExp(`(?:^|/)(${body})(?:/|$)`, "i")
}

/** Framework / transport packages forbidden as value-imports from pure layers. */
export const FRAMEWORK_DENYLIST = new Set([
  "express",
  "fastify",
  "@fastify/websocket",
  "react",
  "react-dom",
  "react/jsx-runtime",
  "drizzle-orm",
  "drizzle-kit",
  "node:http",
  "node:http2",
  "http",
  "http2",
  "mssql",
])

/** Pure layers for trust + framework denylist. */
export const PURE_LAYERS = new Set(["core", "domain"])

/** Identity property names that must not be compared to literals (ops forks). */
export const IDENTITY_NAMES = new Set(["tenantId", "orgId", "customerId", "tenant"])

/**
 * Forbidden `new X` / call X — packages that enable the check.
 * @type {{ name: string, packages: string[] }[]}
 */
export const FORBIDDEN_CONSTRUCTORS = [
  { name: "AsyncLocalStorage", packages: ["agent"] },
]

/**
 * JSX attribute bans (platform control dialects).
 * @type {{ attr: string, value: string, exceptRel: string, packages: string[] }[]}
 */
export const JSX_ATTR_BANS = [
  {
    attr: "type",
    value: "checkbox",
    exceptRel: "components/Checkbox.tsx",
    packages: ["ui"],
  },
]

/**
 * Packages whose public import surface is enforced via package.json exports.
 * Deep filesystem imports into these are always forbidden.
 */
export const BOUNDED_PACKAGES = [
  { npm: "@mia/agent", dir: "packages/agent" },
  { npm: "@mia/sync", dir: "packages/sync" },
  { npm: "@mia/server", dir: "packages/server" },
]

/** Execution cores that must not import the platform shell package. */
export const CORE_PACKAGES = ["agent", "sync"]
export const PLATFORM_NPM = "@mia/server"

/**
 * Catalog coverage specs — wire vocabulary completeness.
 * @type {{
 *   catalogFile: string
 *   catalogConst: string
 *   catalogEndMarker: string
 *   kindsFile: string
 *   kindsType: string
 *   kindsField: string
 *   enumFile: string
 *   enumConst: string
 *   enumUnknownMarker?: string
 * }[]}
 */
export const CATALOG_SPECS = [
  {
    catalogFile: "packages/shared-types/src/event-catalog.ts",
    catalogConst: "TRACE_EVENT_CATALOG",
    catalogEndMarker: "SSE_EVENT_CATALOG",
    kindsFile: "packages/shared-types/src/index.ts",
    kindsType: "TraceEntry",
    kindsField: "kind",
    enumFile: "packages/shared-enums/src/event.ts",
    enumConst: "EventType",
    enumUnknownMarker: "const UNKNOWN",
    sseConst: "SSE_EVENT_CATALOG",
  },
]

/** Where shared enum names live (domain surface fork detection). */
export const SHARED_ENUMS_DIR = "packages/shared-enums/src"

/** UI surface roots for jargon / enum-fork scans (relative to ui src). */
export const DOMAIN_SURFACE_PREFIXES = ["widgets/", "state/", "app/"]

/** Root folder under which apiSurface seams are registered. */
export const SEAM_API_ROOT = "packages/server/src/api"

/** Layers where entropy / map-iteration must be deterministic (injected clock/rng). */
export const DETERMINISTIC_LAYERS = new Set(["core", "domain"])

/** Path prefixes (pkg-relative) treated as trust boundaries for JSON decode. */
export const JSON_BOUNDARY_PREFIXES = ["api/", "client/", "http/"]

/**
 * Files allowed to call JSON.parse (boundary decoders that return unknown).
 * Add a row when introducing a named decoder — never scatter raw parse+assert.
 * @type {string[]}
 */
export const JSON_PARSE_HELPER_FILES = [
  "server/internal/parse-json.ts",
  "ui/lib/parse-json.ts",
  "agent/internal/parse-json.ts",
  "sync/internal/parse-json.ts",
]

/** Property / logging names that must not hit log sinks unredacted. */
export const SECRET_NAME_RE =
  /^(password|passwd|secret|token|apiKey|api_key|authorization|accessToken|refreshToken|privateKey|credential)$/i

/**
 * Files that may define UPPER_SNAKE error `code:` string literals (the registry).
 * Product code must import codes from these — not invent string literals.
 * @type {string[]}
 */
export const ERROR_CODE_REGISTRY_FILES = [
  "packages/shared-enums/src/error-codes.ts",
  "packages/sync/src/domain/entity-registry/types.ts",
  "packages/agent/src/core/plan/platform-errors.ts",
]

/** Port layers must not import these path fragments (concrete adapters/drivers). */
export const PORT_LEAK_PATH_RE = /\/(infra|adapters)\//i
