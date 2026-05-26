/**
 * Server-side `RecipeResolver` implementation — bridges the in-DB entity
 * registry into the agent orchestrator without violating the "agent has
 * no runtime IO deps" invariant. The server wires the returned resolver
 * into `configureAgent({ syncRecipeResolver })` at boot.
 *
 * On every `previewSync` / `executeSync` call, the orchestrator asks the
 * resolver "do you know about this entity?". This implementation:
 *   1. Looks up the current `EntityDefinition` for `(tenantId, entityId)`.
 *   2. Resolves the referenced SCD2 strategy (tenant → _default → bundled).
 *   3. Projects the pair via `projectRecipe(...)` into a `SyncRecipe`.
 *   4. Returns the recipe (or null if either lookup fails — caller will
 *      fall through to the bundled JSON file).
 *
 * Resolution failures (missing strategy etc.) are logged but never thrown;
 * a null return lets the legacy JSON path take over.
 */

import {
    projectRecipe,
    type RecipeResolver,
} from "@mia/agent"
import {
    getEntityDefinition,
    resolveScd2Strategy,
} from "../adapters/persistence/sqlite.js"

const resolver: RecipeResolver = {
  resolve({ tenantId, entityId }) {
    const def = getEntityDefinition(tenantId, entityId)
    if (!def) return null
    const strategy = resolveScd2Strategy(tenantId, def.scd2.strategyId, def.scd2.strategyVersion)
    if (!strategy) {
      console.warn(`[entity-registry] entity "${entityId}" references strategy "${def.scd2.strategyId}" v${def.scd2.strategyVersion} but it could not be resolved; falling back to bundled recipe.`)
      return null
    }
    return {
      recipe: projectRecipe({ def, strategy }),
      policies: {
        approvalPolicyId:    def.policies.approvalPolicyId,
        freezeWindowIds:     def.policies.freezeWindowIds,
        riskMultiplier:      def.policies.riskMultiplier,
        sourceEntityVersion: def.version,
      },
    }
  },
}

export function createRegistryRecipeResolver(): RecipeResolver {
  return resolver
}
