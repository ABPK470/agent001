/**
 * Widget registry — maps widget types to components.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../types"
import { ActiveUsers } from "./ActiveUsers"
import { AgentChat } from "./AgentChat"
import { AgentViz } from "./AgentViz"
import { AuditTrail } from "./AuditTrail"
import { DebugInspector } from "./DebugInspector"
import { EntityRegistry } from "./EntityRegistry"
import { EnvSync } from "./EnvSync"
import { FreezeWindowRegistry } from "./FreezeWindowRegistry"
import { LiveLogs } from "./LiveLogs"
import { MymiDb } from "./MymiDb"
import { OperationLog } from "./OperationLog"
import { OperatorEnvironment } from "./OperatorEnvironment"
import { RunHistory } from "./RunHistory"
import { RunStatus } from "./RunStatus"
import { StepTimeline } from "./StepTimeline"
import { StrategyRegistry } from "./StrategyRegistry"
import { SyncAdmin } from "./SyncAdmin"
import { SyncApprovals } from "./SyncApprovals"
import { SyncEvidence } from "./SyncEvidence"
import { SyncProposals } from "./SyncProposals"
import { TermChat } from "./TermChat"
import { ThreadNav } from "./ThreadNav"
import { ToolStats } from "./ToolStats"

export const widgetRegistry: Record<WidgetType, ComponentType> = {
  "thread-nav": ThreadNav,
  "agent-chat": AgentChat,
  "term-chat": TermChat,
  "agent-viz": AgentViz,
  "run-status": RunStatus,
  "live-logs": LiveLogs,
  "audit-trail": AuditTrail,
  "step-timeline": StepTimeline,
  "tool-stats": ToolStats,
  "run-history": RunHistory,
  "operator-env": OperatorEnvironment,
  "debug-inspector": DebugInspector,
  "mymi-db": MymiDb,
  "active-users": ActiveUsers,
  "env-sync": EnvSync,
  "operation-log": OperationLog,
  "entity-registry": EntityRegistry,
  "scd2-strategies": StrategyRegistry,
  "freeze-windows":  FreezeWindowRegistry,
  "sync-proposals": SyncProposals,
  "sync-approvals": SyncApprovals,
  "sync-evidence":  SyncEvidence,
  "sync-admin":     SyncAdmin,
}
