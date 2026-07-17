/**
 * Path-based entity definition loaders for scaffold / seed flows.
 */

import { readFileSync } from "node:fs"

import { parseEntityDefinitionsFromYaml } from "../domain/sync-definition-scaffold.js"
import type { EntityDefinition } from "../domain/entity-registry/types.js"

/** Load entity definitions from a YAML file on disk. */
export function loadEntityDefinitionsFromDocument(inputPath: string): EntityDefinition[] {
  const text = readFileSync(inputPath, "utf-8")
  return parseEntityDefinitionsFromYaml(text)
}
