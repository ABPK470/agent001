import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const widgetsDir = dirname(fileURLToPath(import.meta.url))

function readWidget(relativePath: string): string {
  return readFileSync(join(widgetsDir, relativePath), "utf8")
}

describe("widget toast migration", () => {
  const cases = [
    { name: "EnvSyncWidget", path: "env-sync/EnvSyncWidget.tsx" },
    { name: "ActiveUsers", path: "ActiveUsers.tsx" },
    { name: "MymiDb", path: "MymiDb.tsx" },
    { name: "TermChat", path: "TermChat.tsx" },
  ] as const

  it.each(cases)("$name uses shared toast stack", ({ path }) => {
    const src = readWidget(path)
    expect(src).toContain("useWidgetToasts")
    expect(src).toContain("<ToastStack")
  })

  it.each(cases)("$name avoids inline notification banner state", ({ path }) => {
    const src = readWidget(path)
    expect(src).not.toContain("setToast")
    expect(src).not.toContain("setAttachError")
    expect(src).not.toContain("attachError &&")
  })
})
