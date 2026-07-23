/**
 * Package doctrine configs — single source of truth for lint-arch.
 * Mirrors docs/doctrine.md; change both together.
 */

import { join } from "node:path"
import { CYCLE_ALLOWLIST } from "./cycle-debt.mjs"
import {
  ENUM_FORK_ALLOWLIST,
  JARGON_ALLOWLIST,
  SILENT_FAILURE_ALLOWLIST,
  TRUST_ALLOWLIST,
} from "./external-debt.mjs"
import { BRAND_TOKENS } from "./registry/policy.mjs"

/** Rules every package runs (order matters only within dependencies). */
export const PACKAGE_RULES = [
  "forbidden-trees",
  "top-level",
  "layers",
  "cycles",
  "module-state",
  "flat-control-flow",
  "scoped-lifecycle",
  "cancellation-flow",
  "resource-cleanup",
  "framework-deny",
  "export-surface",
  "silent-failure",
  "named-outcome",
  "error-registry",
  "schema-at-boundary",
  "branded-types",
  "leak-free-ports",
  "deterministic-execution",
  "deterministic-ordering",
  "data-sanitization",
  "trust",
  "forbidden-constructors",
]

/** Extra per-package rules (data — not if-branches in the entrypoint). */
export const PACKAGE_EXTRA_RULES = {
  server: ["identity-forks"],
  ui: ["jsx-attr-ban", "domain-surface"],
}

/** Global rules after all packages. */
export const GLOBAL_RULES = [
  "seams",
  "branded-path",
  "owned-identities",
  "dialects",
  "catalog-coverage",
  "resolved-inputs",
  "stale-debt",
  "stale-allowlist",
]

/** @param {string} root */
export function createPackageConfigs(root) {
  return {
    agent: {
      name: "agent",
      src: join(root, "packages/agent/src"),
      tsconfig: join(root, "packages/agent/tsconfig.json"),
      layers: new Set([
        "domain",
        "core",
        "runtime",
        "ports",
        "tools",
        "llm",
        "memory",
        "internal",
      ]),
      allowed: {
        domain: new Set(["domain"]),
        core: new Set(["domain", "ports", "tools", "internal"]),
        runtime: new Set([
          "core",
          "domain",
          "ports",
          "tools",
          "llm",
          "memory",
          "internal",
        ]),
        ports: new Set(["domain", "internal"]),
        tools: new Set(["domain", "core", "runtime", "ports", "internal"]),
        llm: new Set(["domain", "internal"]),
        memory: new Set(["domain", "internal"]),
        internal: new Set(["internal"]),
      },
      /** @type {DebtAllow[]} */
      layerAllowlist: [],
      forbiddenTrees: [
        "application",
        "domain/services",
        "concepts",
        "contracts",
        "decisions",
        "engine",
      ],
      stateAllowlist: new Set(["domain/tenant/tenant-config.ts"]),
      timerAllowlist: new Set(["tools/browse-web/session.ts"]),
      skipTestFilesForLayers: false,
      allowedRootFiles: new Set(["index.ts"]),
      allowedExtraDirs: new Set(),
    },

    server: {
      name: "server",
      src: join(root, "packages/server/src"),
      tsconfig: join(root, "packages/server/tsconfig.json"),
      layers: new Set([
        "boot",
        "http",
        "infra",
        "adapters",
        "api",
        "runtime",
        "ports",
        "internal",
        "cli",
      ]),
      allowed: {
        boot: new Set(["boot", "infra", "adapters", "api", "runtime", "ports", "http", "internal"]),
        http: new Set(["http", "api", "infra", "boot", "runtime", "ports", "internal"]),
        api: new Set(["api", "infra", "adapters", "ports", "boot", "runtime", "internal"]),
        runtime: new Set(["runtime", "infra", "adapters", "ports", "api", "boot", "internal"]),
        adapters: new Set(["adapters", "infra", "ports", "api", "internal"]),
        infra: new Set(["infra", "internal", "ports"]),
        ports: new Set(["ports", "internal"]),
        cli: new Set(["cli", "boot", "infra", "api", "runtime", "internal", "adapters"]),
        internal: new Set(["internal"]),
      },
      layerAllowlist: [],
      forbiddenTrees: [
        "crypto",
        "deploy",
        "api/deploy",
        "hosting",
        "api/runs/hosting",
        "bootstrap",
        "app",
        "features",
        "platform",
        "shared",
        "api/runs/core",
        // api/agents erased via seams registry, not a static tree string alone
      ],
      stateAllowlist: new Set([
        "api/proposer/state/scheduler.ts",
        "runtime/prompting/goal-classification.ts",
        "boot/shutdown.ts",
        "infra/llm/databricks-broker.ts",
        "infra/llm/operation-context.ts",
        "infra/persistence/connection.ts",
        "infra/persistence/db/sync-tool-approvals.ts",
        "infra/persistence/evidence/signers/kms-stub.ts",
        "infra/persistence/memory/vectors.ts",
        "infra/queue/channels/teams.ts",
        "infra/sandbox/backend.ts",
        "infra/sandbox/index.ts",
      ]),
      timerAllowlist: new Set(["api/proposer/state/scheduler.ts"]),
      skipTestFilesForLayers: false,
      allowedRootFiles: new Set(["index.ts"]),
      allowedExtraDirs: new Set(),
      forbidApiNestDirs: ["application", "domain", "runtime", "transport"],
    },

    sync: {
      name: "sync",
      src: join(root, "packages/sync/src"),
      tsconfig: join(root, "packages/sync/tsconfig.json"),
      layers: new Set([
        "domain",
        "core",
        "runtime",
        "ports",
        "tools",
        "adapters",
        "internal",
      ]),
      allowed: {
        domain: new Set(["domain", "ports"]),
        core: new Set(["domain", "ports", "internal"]),
        runtime: new Set(["core", "domain", "ports", "adapters", "internal", "tools"]),
        ports: new Set(["domain", "internal"]),
        tools: new Set(["domain", "core", "runtime", "ports", "adapters", "internal"]),
        adapters: new Set(["domain", "ports", "internal"]),
        internal: new Set(["internal"]),
      },
      layerAllowlist: [],
      forbiddenTrees: ["application"],
      stateAllowlist: new Set(["domain/governance/freeze-windows.ts"]),
      timerAllowlist: new Set(),
      skipTestFilesForLayers: true,
      allowedRootFiles: new Set(["index.ts"]),
      allowedExtraDirs: new Set(["test-support"]),
    },

    ui: {
      name: "ui",
      src: join(root, "packages/ui/src"),
      tsconfig: join(root, "packages/ui/tsconfig.json"),
      layers: new Set([
        "boot",
        "app",
        "client",
        "state",
        "widgets",
        "components",
        "hooks",
        "lib",
        "theme",
        "enums",
      ]),
      allowed: {
        boot: new Set(["app", "components", "theme", "enums"]),
        app: new Set([
          "widgets",
          "state",
          "client",
          "components",
          "hooks",
          "lib",
          "enums",
          "theme",
          "app",
        ]),
        widgets: new Set([
          "client",
          "state",
          "app",
          "components",
          "hooks",
          "lib",
          "enums",
          "theme",
          "widgets",
        ]),
        components: new Set(["hooks", "lib", "theme", "enums", "components"]),
        state: new Set(["client", "lib", "enums", "state"]),
        client: new Set(["enums", "lib", "client"]),
        hooks: new Set(["client", "state", "lib", "enums", "hooks"]),
        lib: new Set(["enums", "lib"]),
        theme: new Set(["theme"]),
        enums: new Set(["enums"]),
      },
      layerAllowlist: [],
      forbiddenTrees: [
        "shell",
        "chrome",
        "kit",
        "surfaces",
        "ui",
        "features",
        "api",
        "application",
      ],
      stateAllowlist: new Set([
        "app/workspace/layout/persistence.ts",
        "lib/popover-dismiss.ts",
        "state/store.ts",
        "widgets/bridge/transform-draft.ts",
        "widgets/env-sync/exec-store.ts",
      ]),
      timerAllowlist: new Set(["app/workspace/layout/persistence.ts"]),
      skipTestFilesForLayers: true,
      allowedRootFiles: new Set(["types.ts", "vite-env.d.ts"]),
      allowedExtraDirs: new Set(),
      /** UI-only: treat root types.ts as shared façade (no layer). */
      rootFacades: new Set(["types.ts"]),
    },
  }
}

/** @param {string} root */
export function createLeverageDebt(root) {
  return {
    /** @type {{ pkg: string, key: string, note: string, used?: boolean }[]} */
    cycleAllowlist: CYCLE_ALLOWLIST.map((e) => ({ ...e })),
    /** @type {{ surface: string, note: string, used?: boolean }[]} */
    brandAllowlist: [],
    brandTokens: [...BRAND_TOKENS],
    /** @type {{ name: string, note: string, used?: boolean }[]} */
    unownedIdentityAllowlist: [],
    /** @type {{ file: string, note: string, used?: boolean }[]} */
    presentationAllowlist: [],
    /** @type {{ file: string, note: string, used?: boolean }[]} */
    tenantBranchAllowlist: [],
    silentFailureAllowlist: SILENT_FAILURE_ALLOWLIST.map((e) => ({ ...e })),
    trustAllowlist: TRUST_ALLOWLIST.map((e) => ({ ...e })),
    enumForkAllowlist: ENUM_FORK_ALLOWLIST.map((e) => ({ ...e })),
    jargonAllowlist: JARGON_ALLOWLIST.map((e) => ({ ...e })),
    root,
  }
}

/**
 * @typedef {{
 *   from?: string
 *   fromPrefix?: string
 *   toPrefix?: string
 *   note: string
 *   used?: boolean
 * }} DebtAllow
 */
