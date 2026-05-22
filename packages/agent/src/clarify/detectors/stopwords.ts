// Stop-word list shared by clarification detectors.
//
// These words are too generic to count as the SUBJECT of an ambiguity:
// they appear in nearly every English sentence and would otherwise cause
// every goal to fire a spurious finding.
//
// Tenant-agnostic. Domain-specific stopwords (e.g. "revenue" for a finance
// tenant) MUST NOT live here — those words ARE the subjects the agent is
// asked to clarify. Instead, tenants suppress noise by populating
// `routingKeywords.domain` which the term-undefined detector consults.

/** Common English function words + agent-conversation framing words. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // articles, prepositions, conjunctions
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "by", "from", "as", "into", "onto", "over", "under", "about",
  "between", "across", "per", "via", "within", "without",
  // pronouns
  "i", "me", "my", "we", "us", "our", "you", "your", "they", "them", "their",
  "it", "its", "he", "she", "his", "her", "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose", "where", "when", "why", "how",
  // common verbs / auxiliaries
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "have", "has", "had", "having",
  "will", "would", "should", "could", "can", "may", "might", "must", "shall",
  // agent-conversation framing
  "show", "give", "tell", "find", "list", "get", "fetch", "return", "display",
  "please", "thanks", "thank", "hi", "hello", "hey", "ok",
  "want", "need", "like", "see", "know", "let", "make",
  "rows", "row", "data", "table", "column", "value", "values",
  "result", "results", "report", "query", "queries",
  // numerals & quantifiers
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "last", "next", "previous", "current",
  "any", "all", "some", "every", "each", "no", "not", "only", "just",
  "more", "less", "much", "many", "few", "several", "both", "either", "neither",
  // common adjectives that are not business terms
  "new", "old", "good", "bad", "high", "low", "big", "small", "long", "short",
  "open", "closed", "active", "inactive", "real", "true", "false",
  // misc
  "now", "today", "yesterday", "tomorrow", "soon", "later", "ago",
  "yes", "maybe",
])

/** True iff `token` is a stop-word (case-insensitive). */
export function isStopword(token: string): boolean {
  return STOPWORDS.has(token.toLowerCase())
}

/**
 * Tokenize a goal string into lowercase word tokens, dropping stop-words
 * and tokens shorter than 2 chars. Used by detectors that scan for
 * subject nouns in the goal.
 */
export function goalTokens(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}
