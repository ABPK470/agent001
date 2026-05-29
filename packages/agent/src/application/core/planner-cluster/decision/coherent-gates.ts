import { PlannerNeedLevel } from "../../domain/index.js"
/**
 * Layer 5: sanity override + coherence gates. Extracted from assess.ts.
 *
 * @module
 */

import {
    BOUNDED_COHERENT_SCOPE_RE,
    EXISTING_CODE_COUPLING_RE,
    EXTERNAL_SERVICE_RE,
    LARGE_GREENFIELD_BOOTSTRAP_RE,
} from "../internal/decision-patterns.js"
import {
    type RequestSignals,
    type RoutingAxes,
    hasRealOwnershipSeparation,
} from "./signals.js"

/**
 * Sanity override: a clearly bounded single-system build with no external
 * service dependencies and no genuine coordination signals should never be
 * routed to the full planner.
 */
export function isSanityOverrideBoundedBuild(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  if (EXTERNAL_SERVICE_RE.test(signals.normalized)) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
  if (LARGE_GREENFIELD_BOOTSTRAP_RE.test(signals.normalized)) return false
  if (signals.hasMultiStepCue) return false
  if (signals.structuredBulletCount > 0) return false
  if (axes.coordinationNeed === PlannerNeedLevel.High) return false
  if (signals.priorToolMessages >= 4) return false
  if (hasRealOwnershipSeparation(signals)) return false
  if (signals.targetFilePaths.length > 1) return false
  return true
}

export function shouldUseBoundedCoherentGeneration(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  if (axes.coordinationNeed !== PlannerNeedLevel.Low) return false
  if (hasRealOwnershipSeparation(signals)) return false
  if (signals.priorToolMessages >= 4) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
  if (signals.targetFilePaths.length > 1) return false
  return true
}

export function shouldUsePlannerWithCoherentBootstrap(signals: RequestSignals, axes: RoutingAxes): boolean {
  if (!signals.hasImplementationScopeCue) return false
  if (!BOUNDED_COHERENT_SCOPE_RE.test(signals.normalized)) return false
  if (!LARGE_GREENFIELD_BOOTSTRAP_RE.test(signals.normalized) && signals.structuredBulletCount < 3 && signals.targetFilePaths.length < 3) return false
  if (EXISTING_CODE_COUPLING_RE.test(signals.normalized)) return false
  if (axes.coherenceNeed !== PlannerNeedLevel.High) return false
  if (axes.coordinationNeed === PlannerNeedLevel.Low) return false
  return !(signals.hasDelegationCue && signals.hasMultiStepCue)
}
