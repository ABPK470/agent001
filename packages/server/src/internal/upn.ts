/** Case-insensitive UPN equality — single compare for identity / Personal scope. */
export function sameUpn(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim().toLowerCase()
  const right = b?.trim().toLowerCase()
  return Boolean(left && right && left === right)
}
