/**
 * /api/runtime/profile reflects AGENT_HOSTED_MODE.
 */

import Fastify from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { registerProfileRoutes } from "../src/api/profile.js"

const ENV_KEY = "AGENT_HOSTED_MODE"
let original: string | undefined

beforeEach(() => { original = process.env[ENV_KEY] })
afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = original
})

async function build() {
  const app = Fastify()
  registerProfileRoutes(app)
  return app
}

describe("/api/runtime/profile", () => {
  it("reports developer profile by default", async () => {
    delete process.env[ENV_KEY]
    const app = await build()
    const res = await app.inject({ method: "GET", url: "/api/runtime/profile" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profile: "developer", hosted: false })
  })

  it("reports hosted profile when AGENT_HOSTED_MODE=true", async () => {
    process.env[ENV_KEY] = "true"
    const app = await build()
    const res = await app.inject({ method: "GET", url: "/api/runtime/profile" })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ profile: "hosted", hosted: true })
  })
})
