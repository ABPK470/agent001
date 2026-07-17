import type { CustomValueSourceDefinition } from "@mia/shared-types"

export interface ValueSourceSeed {
  id: string
  label: string
  definition: CustomValueSourceDefinition
}

export const VALUE_SOURCE_SEEDS: ValueSourceSeed[]
