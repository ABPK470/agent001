import type { Me } from "../hooks/useMe"

export function accountDisplayName(me: Me): string {
  const name = me.displayName.trim()
  if (name && name !== "Anonymous") return name
  return me.upn.split("@")[0] ?? me.upn
}

/** Role label shown in the session panel. */
export function accountRoleLabel(me: Me): string {
  return me.isAdmin ? "ADMIN" : "OPERATOR"
}

/** UPN line — omitted when it would repeat the display name. */
export function accountSubtitle(me: Me): string | null {
  const name = accountDisplayName(me).toLowerCase()
  const upn = me.upn.trim()
  if (!upn) return null

  const upnLower = upn.toLowerCase()
  if (upnLower === name) return null

  const local = upnLower.split("@")[0] ?? ""
  if (local === name && upn.includes("@")) return upn

  return upn
}
