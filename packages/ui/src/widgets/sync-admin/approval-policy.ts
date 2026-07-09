export type ApprovalPolicyKind = "none" | "single" | "dual"

export interface ApprovalPolicyRow {
  targetEnv: string
  riskTier: string
  policy: ApprovalPolicyKind
}

const PLATFORM_DEFAULTS: Readonly<Record<string, ApprovalPolicyKind>> = {
  low: "none",
  medium: "single",
  high: "dual",
  critical: "dual",
}

export function defaultApprovalPolicy(riskTier: string): ApprovalPolicyKind {
  return PLATFORM_DEFAULTS[riskTier] ?? "dual"
}

/** Mirrors server `getApprovalPolicy` — exact (tenant, target_env, risk_tier) match, else platform default. */
export function resolveApprovalPolicy(
  policies: readonly ApprovalPolicyRow[],
  targetEnv: string,
  riskTier: string | null,
): ApprovalPolicyKind {
  const tier = riskTier ?? "low"
  const row = policies.find((p) => p.targetEnv === targetEnv && p.riskTier === tier)
  return row?.policy ?? defaultApprovalPolicy(tier)
}

export function approvalRequired(policy: ApprovalPolicyKind): boolean {
  return policy !== "none"
}

export function normalizeApprovalPolicyRow(row: Record<string, unknown>): ApprovalPolicyRow {
  return {
    targetEnv: String(row.targetEnv ?? row.target_env ?? "*"),
    riskTier: String(row.riskTier ?? row.risk_tier ?? ""),
    policy: String(row.policy ?? row.kind ?? "single") as ApprovalPolicyKind,
  }
}
