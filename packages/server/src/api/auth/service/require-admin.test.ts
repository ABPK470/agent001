import { describe, expect, it } from "vitest"
import { requireAdmin } from "./require-admin.js"

describe("requireAdmin", () => {
  it("allows admin sessions", async () => {
    const reply = {
      code: (n: number) => {
        expect(n).not.toBe(403)
        return reply
      },
      send: (body: unknown) => body,
    }
    const req = { session: { isAdmin: true } }
    await requireAdmin(req as never, reply as never)
  })

  it("rejects non-admin with 403", async () => {
    let status = 0
    let body: unknown
    const reply = {
      code: (n: number) => {
        status = n
        return reply
      },
      send: (payload: unknown) => {
        body = payload
        return payload
      },
    }
    await requireAdmin({ session: { isAdmin: false } } as never, reply as never)
    expect(status).toBe(403)
    expect(body).toEqual({ error: "admin only" })
  })
})
