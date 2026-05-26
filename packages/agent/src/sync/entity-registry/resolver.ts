/**
 * RecipeResolver — dependency-injection seam for the sync orchestrator.
 *
 * The agent package has historically loaded recipes from the bundled
 * `deploy/mssql/sync-recipes.json` file. Phase 0 of the entity-registry
 * uplift adds a second source: stored `EntityDefinition`s projected via
 * the `RecipeProjector` (see `./projector.ts`). To keep the agent
 * package free of runtime IO (no `better-sqlite3` etc.), the resolver
 * is an interface — the server installs an implementation at boot and
 * the orchestrator calls through it.
 *
 * Lookup order at the agent layer:
 *   1. If a resolver has been installed, ask it for `(tenantId, entityId)`.
 *      A non-null response wins.
 *   2. Otherwise (or on null), fall through to the legacy JSON bundle.
 *
 * Tests and production callers wire a resolver into the host once via
 * `configureAgent({ syncRecipeResolver })`; lookup stays explicit.
 */

import type { AgentHost } from "../../application/shell/runtime.js"
import type { SyncRecipe } from "../recipes.js"

/**
 * Policy snapshot pulled at recipe-resolution time. Threaded into the
 * SyncPlan so governance evaluation (freeze windows, approval policies)
 * sees the entity-as-it-was-then.
 */
export interface ResolvedRecipePolicies {
  approvalPolicyId: string | null
  freezeWindowIds: string[]
  riskMultiplier: number
  /** Entity version the policies were read from. */
  sourceEntityVersion: number
}

export interface ResolvedRecipe {
  recipe: SyncRecipe
  policies: ResolvedRecipePolicies | null
}

export interface RecipeResolver {
  /**
   * Resolve a recipe + policies for the given (tenantId, entityId).
   * Returns null when the registry doesn't know about this entity (the
   * caller falls through to bundled recipes). The returned `SyncRecipe`
   * is fully snapshotted — same shape the bundled recipes have.
   */
  resolve(args: { tenantId: string; entityId: string }): ResolvedRecipe | null
}

export function installRecipeResolver(host: AgentHost, resolver: RecipeResolver | null): void {
  host.sync.recipeResolver = resolver
}

export function getRecipeResolver(host: AgentHost): RecipeResolver | null {
  return host.sync.recipeResolver
}

/**
 * Convenience: try the resolver, return null on miss / when no resolver.
 * Pure read; orchestrator callers should prefer this over reaching into
 * `installed` directly.
 */
export function tryResolveRecipe(host: AgentHost, args: { tenantId: string; entityId: string }): ResolvedRecipe | null {
  const resolver = host.sync.recipeResolver
  if (!resolver) return null
  try {
    return resolver.resolve(args)
  } catch (e) {
    console.warn("[sync] RecipeResolver threw; falling back to bundled JSON:", e instanceof Error ? e.message : e)
    return null
  }
}
