import type { ClarifyContext } from "../types.js"

export function mergeReservedTokens(ctx: ClarifyContext): ReadonlySet<string> | undefined {
  const vocab = ctx.domainVocabulary?.reservedTokens
  const sync = ctx.syncOperationIntent?.reservedTokens
  if (!vocab && !sync) return undefined
  if (!vocab) return sync
  if (!sync) return vocab
  return new Set([...vocab, ...sync])
}
