/** Utility functions. */

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "..." : str
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed": return "var(--color-success)"
    case "failed": return "var(--color-error)"
    case "running": case "pending": case "planning": return "var(--color-accent)"
    case "cancelled": return "var(--color-warning)"
    default: return "var(--color-text-muted)"
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
