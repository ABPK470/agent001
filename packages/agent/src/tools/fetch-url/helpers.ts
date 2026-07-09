/**
 * Helpers for fetch-url: SSRF guards. Extracted from fetch-url.ts.
 *
 * @module
 */

/** Check hostname against known-bad patterns (before DNS resolution). */
export function checkHostname(hostname: string): string | null {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    return `Error: Access to internal/private addresses is blocked`
  }
  return null
}

/** Check a resolved IP address against private/internal ranges. */
export function checkResolvedIp(ip: string): string | null {
  // IPv4 private ranges
  if (
    ip === "127.0.0.1" ||
    ip === "0.0.0.0" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }

  // IPv6 private/loopback
  if (
    ip === "::1" ||
    ip === "::" ||
    ip.startsWith("fc") || // unique local
    ip.startsWith("fd") || // unique local
    ip.startsWith("fe80") // link-local
  ) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1, ::ffff:10.0.0.1)
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped) {
    return checkResolvedIp(v4Mapped[1])
  }

  return null
}
