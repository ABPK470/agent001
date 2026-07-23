/** Branded owned identities — domain/core only; cast at composition boundaries. */

export type RunId = string & { readonly __brand: "RunId" }
export type ParentRunId = string & { readonly __brand: "ParentRunId" }
export type ToolCallId = string & { readonly __brand: "ToolCallId" }
export type PlanId = string & { readonly __brand: "PlanId" }
export type StepId = string & { readonly __brand: "StepId" }
export type DefinitionId = string & { readonly __brand: "DefinitionId" }
export type EntityId = string & { readonly __brand: "EntityId" }
export type ConnectorId = string & { readonly __brand: "ConnectorId" }
export type SourceId = string & { readonly __brand: "SourceId" }
export type TargetId = string & { readonly __brand: "TargetId" }

export function asRunId(v: string): RunId {
  return v as RunId
}
export function asParentRunId(v: string): ParentRunId {
  return v as ParentRunId
}
export function asToolCallId(v: string): ToolCallId {
  return v as ToolCallId
}
export function asPlanId(v: string): PlanId {
  return v as PlanId
}
export function asStepId(v: string): StepId {
  return v as StepId
}
export function asDefinitionId(v: string): DefinitionId {
  return v as DefinitionId
}
export function asEntityId(v: string): EntityId {
  return v as EntityId
}
export function asConnectorId(v: string): ConnectorId {
  return v as ConnectorId
}
export function asSourceId(v: string): SourceId {
  return v as SourceId
}
export function asTargetId(v: string): TargetId {
  return v as TargetId
}
