/**
 * Widget registry — maps widget types to components.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../types"
import { ActiveUsers } from "./ActiveUsers"
import { AgentChat } from "./AgentChat"
import { DebugInspector } from "./DebugInspector"
import { EntityRegistry } from "./EntityRegistry"
import { EnvSync } from "./EnvSync"
import { LiveLogs } from "./LiveLogs"
import { MymiDb } from "./MymiDb"
import { OperationLog } from "./OperationLog"
import { OperatorEnvironment } from "./OperatorEnvironment"
import { RunHistory } from "./RunHistory"
import { RunStatus } from "./RunStatus"
import { StepTimeline } from "./StepTimeline"
import { SyncAdmin } from "./SyncAdmin"
import { SyncApprovals } from "./SyncApprovals"
import { SyncEvidence } from "./SyncEvidence"
import { SyncProposals } from "./SyncProposals"
import { TermChat } from "./TermChat"
import { ThreadNav } from "./ThreadNav"

export const widgetRegistry: Record<WidgetType, ComponentType> = {
  "thread-nav": ThreadNav,
  "agent-chat": AgentChat,
  "term-chat": TermChat,
  "run-status": RunStatus,
  "live-logs": LiveLogs,
  "step-timeline": StepTimeline,
  "run-history": RunHistory,
  "operator-env": OperatorEnvironment,
  "debug-inspector": DebugInspector,
  "mymi-db": MymiDb,
  "active-users": ActiveUsers,
  "env-sync": EnvSync,
  "operation-log": OperationLog,
  "entity-registry": EntityRegistry,
  "sync-proposals": SyncProposals,
  "sync-approvals": SyncApprovals,
  "sync-evidence":  SyncEvidence,
  "sync-admin":     SyncAdmin,
}
