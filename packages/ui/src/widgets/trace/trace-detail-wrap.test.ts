import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, "../../boot/index.css"), "utf8")

describe("trace detail wrap contract", () => {
  it("keeps detail sections shrinkable in the split pane", () => {
    expect(css).toMatch(/\.trace-tool-io__section\s*\{[^}]*min-width:\s*0/s)
    expect(css).toMatch(/\.trace-detail-body\s*\{[^}]*min-width:\s*0/s)
  })

  it("raw error / playground pre bodies also wrap long tokens", () => {
    expect(css).toMatch(
      /\.trace-error-block__trace\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    )
    expect(css).toMatch(
      /\.trace-playground__result\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    )
  })
})

