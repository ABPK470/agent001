import { describe, expect, it } from "vitest"
import { isChatTableExportDisabled } from "./chat-table-export-gate"

describe("isChatTableExportDisabled", () => {
  it("allows export when the answer is settled (post-stream)", () => {
    expect(isChatTableExportDisabled({ exportSettled: true })).toBe(false)
  })

  it("blocks export while streaming / revealing", () => {
    expect(isChatTableExportDisabled({ exportSettled: false })).toBe(true)
  })

  it("blocks only while the table itself is mid-print — not settle animation", () => {
    // Regression: settling used to be OR'd in and stayed true forever after
    // collectEnteringStructuredIndices kept enteredKeys for CSS fill-mode.
    expect(
      isChatTableExportDisabled({ exportSettled: true, tablePrinting: false }),
    ).toBe(false)
    expect(
      isChatTableExportDisabled({ exportSettled: true, tablePrinting: true }),
    ).toBe(true)
  })
})
