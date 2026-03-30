/**
 * Widget registry — maps widget types to components.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../types"
import { AgentChat } from "./AgentChat"
import { AgentTrace } from "./AgentTrace"
import { AgentViz } from "./AgentViz"
import { AuditTrail } from "./AuditTrail"
import { LiveLogs } from "./LiveLogs"
import { RunHistory } from "./RunHistory"
import { RunStatus } from "./RunStatus"
import { StepTimeline } from "./StepTimeline"
import { ToolStats } from "./ToolStats"

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
}
