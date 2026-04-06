/**
 * Widget registry — maps widget types to components.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../types"
import { AgentChat } from "./AgentChat"
import { AgentTrace } from "./AgentTrace"
import { AgentViz } from "./AgentViz"
import { AuditTrail } from "./AuditTrail"
import { CommandCenter } from "./CommandCenter"
import { DebugInspector } from "./DebugInspector"
import { LiveLogs } from "./LiveLogs"
import { OperatorEnvironment } from "./OperatorEnvironment"
import { PlatformDevLog } from "./PlatformDevLog"
import { RunHistory } from "./RunHistory"
import { RunStatus } from "./RunStatus"
import { StepTimeline } from "./StepTimeline"
import { ToolStats } from "./ToolStats"
import { TrajectoryReplay } from "./TrajectoryReplay"
import { UniverseViz } from "./UniverseViz"

export const widgetRegistry: Record<WidgetType, ComponentType> = {
  "agent-chat": AgentChat,
  "agent-trace": AgentTrace,
  "agent-viz": AgentViz,
  "run-status": RunStatus,
  "live-logs": LiveLogs,
  "audit-trail": AuditTrail,
  "step-timeline": StepTimeline,
  "tool-stats": ToolStats,
  "run-history": RunHistory,
  "command-center": CommandCenter,
  "trajectory-replay": TrajectoryReplay,
  "operator-env": OperatorEnvironment,
  "debug-inspector": DebugInspector,
  "platform-dev-log": PlatformDevLog,
  "universe-viz": UniverseViz,
}
