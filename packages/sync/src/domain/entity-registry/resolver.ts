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
 * Tests can install ad-hoc resolvers via {@link installRecipeResolver};
 * production callers install one once at startup and never replace it.
 */

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

let installed: RecipeResolver | null = null

export function installRecipeResolver(r: RecipeResolver | null): void {
  installed = r
}

export function getRecipeResolver(): RecipeResolver | null {
  return installed
}

/**
 * Convenience: try the resolver, return null on miss / when no resolver.
 * Pure read; orchestrator callers should prefer this over reaching into
 * `installed` directly.
 */
export function tryResolveRecipe(args: { tenantId: string; entityId: string }): ResolvedRecipe | null {
  if (!installed) return null
  try {
    return installed.resolve(args)
  } catch (e) {
    console.warn("[sync] RecipeResolver threw; falling back to bundled JSON:", e instanceof Error ? e.message : e)
    return null
  }
}
