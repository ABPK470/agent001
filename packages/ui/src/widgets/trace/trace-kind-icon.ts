/**
 * Kind → Lucide icon — one map for tree rows and waterfall labels.
 */

import { Brain, Cpu, Layers, Mail, MessageSquare, Reply, Wrench, Zap, type LucideIcon } from "lucide-react"
import type { TraceTreeNodeKind } from "./trace-tree-index"

export const TRACE_KIND_ICON: Record<TraceTreeNodeKind, LucideIcon> = {
  context: Layers,
  prompt: Cpu,
  tools: Wrench,
  phase: Layers,
  call: Brain,
  sent: Mail,
  received: Reply,
  message: MessageSquare,
  work: Zap,
  tool: Wrench,
}
