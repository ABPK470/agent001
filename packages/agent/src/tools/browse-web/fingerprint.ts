/**
 * Browser fingerprint pool — deterministic per-tenant when a seed is supplied,
 * random otherwise. Used by browse-web to make sessions look like distinct
 * real users instead of identical headless bots.
 *
 * The pool is intentionally small and curated to recent Chrome/Edge versions
 * on Mac/Windows/Linux desktops with realistic viewport/locale/timezone
 * combinations. No paid services or external lookups.
 *
 * @module
 */

export interface Fingerprint {
  userAgent: string
  viewport: { width: number; height: number }
  locale: string
  timezoneId: string
  platform: "MacIntel" | "Win32" | "Linux x86_64"
}

const POOL: Fingerprint[] = [
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    platform: "MacIntel",
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    viewport: { width: 1680, height: 1050 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    platform: "MacIntel",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    platform: "Win32",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    platform: "Win32",
  },
  {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1600, height: 900 },
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    platform: "Linux x86_64",
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1536, height: 864 },
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
    platform: "Win32",
  },
]

/**
 * FNV-1a 32-bit hash. Tiny, deterministic, dependency-free; sufficient for
 * mapping a tenant identifier to a stable fingerprint slot.
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

/**
 * Pick a fingerprint from the pool.
 * - With a seed: deterministic (same tenant → same fingerprint across sessions).
 * - Without a seed: random (anonymous one-shot sessions).
 */
export function pickFingerprint(seed?: string): Fingerprint {
  const idx =
    seed !== undefined && seed !== ""
      ? fnv1a(seed) % POOL.length
      : Math.floor(Math.random() * POOL.length)
  // Defensive copy — callers may mutate viewport.
  const fp = POOL[idx]!
  return { ...fp, viewport: { ...fp.viewport } }
}

/** Exposed for tests. */
export function fingerprintPoolSize(): number {
  return POOL.length
}
