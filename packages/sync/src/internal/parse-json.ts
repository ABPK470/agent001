/** Boundary JSON decoder — returns unknown; callers must validate. */
export function parseBoundaryJson(text: string): unknown {
  return JSON.parse(text)
}
