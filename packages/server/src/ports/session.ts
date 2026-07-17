/**
 * Authenticated session facts captured at the HTTP boundary.
 * Downstream code must pass these explicitly — no ambient lookup.
 */
export interface CurrentSession {
  sid: string
  displayName: string
  upn: string
  isAdmin: boolean
  ip: string
  userAgent: string
}
