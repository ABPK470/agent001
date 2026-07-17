import {
  computeAutoDetectedExcludeDirs,
  configureAgent,
  makeRunContext,
  PolicyRole,
  PolicyRunMode,
  type AgentHost,
  type HostedPolicyContext
} from "@mia/agent"
import { bootHostDepsToConfigureAgentOptions } from "../../../../bootstrap/boot-host-adapter.js"
import { createServerAttachmentService } from "../../../../platform/persistence/attachments.js"
import {
  ingestAgentNote,
  listTableVerdicts,
  lookupToolKnowledge,
  renderCachedHeader,
  saveToolKnowledge
} from "../../../../platform/persistence/memory.js"
import * as db from "../../../../platform/persistence/sqlite.js"
import type { ActiveRunRecord, ExecuteRunCommand, PerRunHostBundle, RunWorkspace } from "./types.js"

function createRunContextForExecution(
  activeRun: ActiveRunRecord | undefined,
  runId: string,
  controller: AbortController
) {
  return makeRunContext({
    signal: controller.signal,
    memory: {
      writeNote: (payload) => {
        try {
          ingestAgentNote({
            subject: payload.subject,
            claim: payload.claim,
            evidence: payload.evidence,
            category: payload.category,
            runId,
            upn: activeRun?.ownerUpn ?? null
          })
        } catch {
          // Side-channel persistence must not break the run.
        }
      }
    }
  })
}

function createPolicyContext(
  runId: string,
  activeRun: ActiveRunRecord | undefined,
  runWorkspace: RunWorkspace,
  opts?: { parentRunId?: string | null }
): HostedPolicyContext {
  const role = activeRun?.role ?? PolicyRole.Admin
  const grantRunIds = [runId, opts?.parentRunId].filter((id): id is string => !!id)
  const toolApprovalGrants = db.listApprovedToolGrantsForRuns(grantRunIds).map((grant) => ({
    grantId: grant.id,
    toolName: grant.toolName,
    args: grant.args,
  }))

  return {
    runId,
    parentRunId: opts?.parentRunId ?? null,
    runMode: role === PolicyRole.HostedUser ? PolicyRunMode.Hosted : PolicyRunMode.Developer,
    role,
    sandboxRoot: runWorkspace.executionRoot,
    actorUpn: activeRun?.ownerUpn ?? null,
    toolApprovalGrants: toolApprovalGrants.length > 0 ? toolApprovalGrants : undefined,
  }
}

export function createPerRunHost(
  command: ExecuteRunCommand,
  activeRun: ActiveRunRecord | undefined,
  runWorkspace: RunWorkspace
): PerRunHostBundle {
  const { request, runtime } = command
  const runContext = createRunContextForExecution(activeRun, request.runId, runtime.controller)
  const policyCtx = createPolicyContext(request.runId, activeRun, runWorkspace, {
    parentRunId: request.resume?.parentRunId ?? null,
  })
  const bootOptions = bootHostDepsToConfigureAgentOptions(runtime.bootHostDeps)
  const perRunHost: AgentHost = configureAgent({
    ...bootOptions,
    sync: {
      ...bootOptions.sync,
      runs: {
        ...bootOptions.sync?.runs,
        actorUpn: activeRun?.ownerUpn ?? null
      }
    },
    attachments: createServerAttachmentService(() => policyCtx),
    workspaceRoot: runWorkspace.executionRoot,
    filesystemBasePath: runWorkspace.executionRoot,
    searchFilesBasePath: runWorkspace.executionRoot,
    searchFilesExcludeDirs: new Set(computeAutoDetectedExcludeDirs(runWorkspace.executionRoot)),
    shellCwd: runWorkspace.executionRoot,
    toolKnowledge: {
      lookup: (args) =>
        lookupToolKnowledge(args) as unknown as ReturnType<NonNullable<AgentHost["toolKnowledge"]>["lookup"]>,
      save: (args) => saveToolKnowledge({ ...args, upn: activeRun?.ownerUpn ?? null }),
      renderHeader: (hit, opts) =>
        renderCachedHeader(hit as unknown as Parameters<typeof renderCachedHeader>[0], opts)
    },
    tableVerdicts: {
      list: (args) => listTableVerdicts({ qnames: args.qnames, connection: args.connection })
    }
  })

  const debugSeqRef = { value: 0 }

  return { runContext, perRunHost, policyCtx, debugSeqRef }
}
