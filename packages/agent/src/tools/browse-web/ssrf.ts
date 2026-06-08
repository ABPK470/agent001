/**
 * SSRF protections for browse_web — same rules as fetch_url:
 * block non-http(s), block private/loopback/link-local addresses
 * pre- and post-DNS-resolve.
 *
 * @module
 */

import { lookup } from "node:dns/promises"

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
    return "Error: Access to internal/private addresses is blocked"
  }
  return null
}

export function checkResolvedIp(ip: string): string | null {
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
  if (ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) {
    return `Error: Access to internal/private addresses is blocked (resolved to ${ip})`
  }
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4Mapped) return checkResolvedIp(v4Mapped[1])
  return null
}

export async function validateUrl(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `Error: Invalid URL "${url}"`
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Error: Only http/https URLs are supported"
  }
  const hostErr = checkHostname(parsed.hostname)
  if (hostErr) return hostErr
  try {
    const resolved = await lookup(parsed.hostname)
    return checkResolvedIp(resolved.address)
  } catch {
    return `Error: Could not resolve hostname "${parsed.hostname}"`
  }
}
