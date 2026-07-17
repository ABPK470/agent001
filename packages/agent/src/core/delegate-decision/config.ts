/**
 * Resolve user-supplied DelegationDecisionConfig into a fully-defaulted
 * ResolvedDelegationDecisionConfig.
 *
 * @module
 */

import {
  DEFAULT_HARD_BLOCKED_TASK_CLASSES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FANOUT_PER_TURN,
  DEFAULT_SCORE_THRESHOLD,
  clamp01,
  isValidHardBlockedClass,
  type DelegationDecisionConfig,
  type DelegationHardBlockedTaskClass,
  type ResolvedDelegationDecisionConfig
} from "./types.js"

export function resolveDelegationDecisionConfig(
  config?: DelegationDecisionConfig
): ResolvedDelegationDecisionConfig {
  const hardBlockedTaskClasses = new Set<DelegationHardBlockedTaskClass>()
  const configured = config?.hardBlockedTaskClasses
  if (Array.isArray(configured)) {
    for (const tc of configured) {
      if (isValidHardBlockedClass(tc)) hardBlockedTaskClasses.add(tc)
    }
  } else {
    for (const tc of DEFAULT_HARD_BLOCKED_TASK_CLASSES) {
      hardBlockedTaskClasses.add(tc)
    }
  }
  return {
    enabled: config?.enabled ?? true,
    scoreThreshold: clamp01(config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD),
    maxFanoutPerTurn: Math.max(1, Math.floor(config?.maxFanoutPerTurn ?? DEFAULT_MAX_FANOUT_PER_TURN)),
    maxDepth: Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    hardBlockedTaskClasses
  }
}
