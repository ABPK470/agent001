import { describe, expect, it, vi } from "vitest"
import { consumeOpenAICompatibleSSE } from "../src/llm/openai-compat.js"

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const payload = lines.map((line) => `${line}\n`).join("")
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    }
  })
}

describe("consumeOpenAICompatibleSSE", () => {
  it("emits content deltas incrementally", async () => {
    const tokens: string[] = []
    const result = await consumeOpenAICompatibleSSE(
      sseBody([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        "data: [DONE]"
      ]),
      { onToken: (token) => tokens.push(token) }
    )
    expect(tokens).toEqual(["Hel", "lo"])
    expect(result.content).toBe("Hello")
  })

  it("stops emitting content and signals discard when tool calls begin", async () => {
    const tokens: string[] = []
    let discardCount = 0
    const result = await consumeOpenAICompatibleSSE(
      sseBody([
        'data: {"choices":[{"delta":{"content":"Draft "}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"query","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}',
        "data: [DONE]"
      ]),
      {
        onToken: (token) => tokens.push(token),
        onFirstToolCallDelta: () => {
          discardCount++
        }
      }
    )
    expect(tokens).toEqual(["Draft "])
    expect(discardCount).toBe(1)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe("query")
  })
})

describe("DatabricksClient streaming", () => {
  it("requests stream=true and forwards token deltas", async () => {
    const { DatabricksClient } = await import("../src/llm/databricks.js")
    const tokens: string[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body.stream).toBe(true)
      return new Response(
        sseBody([
          'data: {"choices":[{"delta":{"content":"Revenue "}}]}',
          'data: {"choices":[{"delta":{"content":"trend"}}]}',
          "data: [DONE]"
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const client = new DatabricksClient({
      host: "https://example.databricks.com",
      endpoint: "gpt-test",
      getToken: async () => "token"
    })

    const response = await client.chat([], [], { onToken: (t) => tokens.push(t) })
    expect(tokens).toEqual(["Revenue ", "trend"])
    expect(response.content).toBe("Revenue trend")
    vi.unstubAllGlobals()
  })
})
