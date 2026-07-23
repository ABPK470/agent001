export interface BlueprintFunctionSpec {
  readonly name: string
  readonly signature: string
}

export interface BlueprintSharedTypeSpec {
  readonly name: string
  readonly definition: string
  readonly usedBy: readonly string[]
}

export interface BlueprintFileSpec {
  readonly declaredPath: string
  readonly basename: string
  readonly functions: readonly BlueprintFunctionSpec[]
  readonly structuralMarkers: readonly string[]
}

export interface BlueprintContractBlock {
  readonly version: number
  readonly files: readonly BlueprintFileSpec[]
  readonly sharedTypes: readonly BlueprintSharedTypeSpec[]
}

export interface ParsedBlueprintContractBlock {
  readonly present: boolean
  readonly files: readonly BlueprintFileSpec[]
  readonly sharedTypes: readonly BlueprintSharedTypeSpec[]
  readonly errors: readonly string[]
}
