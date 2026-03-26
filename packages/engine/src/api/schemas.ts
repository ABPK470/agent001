import { z } from "zod"

// ── Workflow ─────────────────────────────────────────────────────

const ParameterDefSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
})

const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  backoffMs: z.number().int().nonnegative(),
})

const StepDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  action: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  dependsOn: z.array(z.string()).optional(),
  condition: z.string().optional(),
  retryPolicy: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  onError: z.enum(["fail", "skip", "continue"]).optional(),
})

const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  inputSchema: z.record(ParameterDefSchema).default({}),
  steps: z.array(StepDefinitionSchema).min(1),
  tags: z.array(z.string()).optional(),
})

export const CreateWorkflowSchema = WorkflowDefinitionSchema

export const RunCreateSchema = z.object({
  input: z.record(z.unknown()).default({}),
})

export const ApprovalResolveSchema = z.object({
  approved: z.boolean(),
  user: z.string().min(1),
})
