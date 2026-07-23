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
      layerAllowlist: [
        {
          from: "domain/types/agent-loop-state.ts",
          toPrefix: "core/",
          note: "CircuitBreaker type; move type to domain or ports when safe",
        },
        {
          from: "domain/types/agent-loop-state.ts",
          toPrefix: "tools/",
          note: "Tool loop state shapes; move to domain/types when safe",
        },
        {
          from: "domain/tenant/known-vocabulary.ts",
          toPrefix: "tools/",
          note: "Catalog graph vocabulary; keep allowlisted until domain owns the type",
        },
        {
          fromPrefix: "core/plan/",
          toPrefix: "runtime/delegate",
          note: "Delegate validation/escalation purity debt — migrate into core/",
        },
      ],
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
        "ports",
        "internal",
        "cli",
      ]),
      allowed: {
        boot: new Set(["boot", "infra", "adapters", "api", "ports", "http", "internal"]),
        http: new Set(["http", "api", "infra", "boot", "ports", "internal"]),
        api: new Set(["api", "infra", "adapters", "ports", "boot", "internal"]),
        adapters: new Set(["adapters", "infra", "ports", "internal"]),
        infra: new Set(["infra", "internal", "ports"]),
        ports: new Set(["ports", "internal"]),
        cli: new Set(["cli", "boot", "infra", "api", "internal", "adapters"]),
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
        "api/runs/prompting/goal-classification.ts",
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
    brandAllowlist: [
      {
        surface: "mymi",
        note: "Rename api/mymi → domain noun (warehouse/connector); branded path is ops debt",
      },
    ],
    /** @type {{ file: string, note: string, used?: boolean }[]} */
    presentationAllowlist: [
      {
        file: "packages/ui/src/widgets/AgentChat.tsx",
        note: "TOOL_LABELS → move to @mia/shared-types presentation helper",
      },
      {
        file: "packages/ui/src/widgets/TermChat.tsx",
        note: "TOOL_LABELS / TOOL_PAST_TENSE → shared-types",
      },
    ],
    /** @type {{ file: string, note: string, used?: boolean }[]} */
    tenantBranchAllowlist: [
      {
        file: "server/infra/persistence/db/entity-registry.ts",
        note: "DEFAULT_TENANT_ID dual-read inheritance — move to data policy",
      },
      {
        file: "server/infra/persistence/db/freeze-windows.ts",
        note: "DEFAULT_TENANT_ID registry refresh — move to data policy",
      },
    ],
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
