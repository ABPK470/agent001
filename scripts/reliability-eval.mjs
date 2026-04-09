#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_MS = 2000

class HttpError extends Error {
    constructor(status, statusText, data) {
        super(`${status} ${statusText}: ${JSON.stringify(data)}`)
        this.name = "HttpError"
        this.status = status
        this.statusText = statusText
        this.data = data
    }
}

function parseArgs(argv) {
    const args = {
        server: process.env.AGENT_EVAL_SERVER_URL ?? "http://localhost:3000",
        suite: resolve(process.cwd(), "docs/reliability-benchmark.sample.json"),
        timeoutMs: Number(process.env.AGENT_EVAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
        pollMs: Number(process.env.AGENT_EVAL_POLL_MS ?? DEFAULT_POLL_MS),
        output: "",
    }

    for (let i = 0; i < argv.length; i += 1) {
        const value = argv[i]
        if (value === "--server" && argv[i + 1]) args.server = String(argv[++i])
        else if (value === "--suite" && argv[i + 1]) args.suite = resolve(process.cwd(), String(argv[++i]))
        else if (value === "--timeout-ms" && argv[i + 1]) args.timeoutMs = Number(argv[++i])
        else if (value === "--poll-ms" && argv[i + 1]) args.pollMs = Number(argv[++i])
        else if (value === "--output" && argv[i + 1]) args.output = resolve(process.cwd(), String(argv[++i]))
    }

    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number")
    }
    if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) {
        throw new Error("--poll-ms must be a positive number")
    }

    return args
}

async function loadSuite(path) {
    const raw = await readFile(path, "utf8")
    const suite = JSON.parse(raw)
    if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
        throw new Error("suite.cases must be a non-empty array")
    }
    return suite
}

async function jsonFetch(url, options = {}) {
    const hasBody = options.body !== undefined && options.body !== null
    const headers = {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(options.headers ?? {}),
    }

    const response = await fetch(url, {
        ...options,
        headers,
    })

    const text = await response.text()
    let data = null
    if (text) {
        try {
            data = JSON.parse(text)
        } catch {
            data = { raw: text }
        }
    }

    if (!response.ok) {
        throw new HttpError(response.status, response.statusText, data)
    }

    return data
}

async function waitForRun(server, runId, timeoutMs, pollMs) {
    const started = Date.now()
    for (; ;) {
        let run
        try {
            run = await jsonFetch(`${server}/api/runs/${runId}`)
        } catch (error) {
            // A run can be queued before its DB row is visible; tolerate brief 404s.
            if (error instanceof HttpError && error.status === 404) {
                if (Date.now() - started > timeoutMs) {
                    throw new Error(`Run ${runId} was not visible before timeout (${timeoutMs}ms)`)
                }
                await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs))
                continue
            }
            throw error
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
            return run
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Run ${runId} timed out after ${timeoutMs}ms`)
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs))
    }
}

async function maybeApplyWorkspaceDiff(server, runId, spec) {
    if (!spec.applyWorkspaceDiff) return null
    try {
        const applied = await jsonFetch(`${server}/api/runs/${runId}/workspace-diff/apply`, {
            method: "POST",
        })
        return applied
    } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
            return { ok: false, reason: "no_pending_workspace_diff" }
        }
        throw error
    }
}

function evaluateCase(run, trace, spec) {
    const errors = []

    if (spec.expectStatus && run.status !== spec.expectStatus) {
        errors.push(`expected status ${spec.expectStatus}, received ${run.status}`)
    }

    if (Array.isArray(spec.answerIncludes)) {
        const answer = String(run.answer ?? "")
        for (const token of spec.answerIncludes) {
            if (!answer.includes(token)) errors.push(`answer missing token: ${token}`)
        }
    }

    if (Array.isArray(spec.traceMustIncludeKinds)) {
        const kinds = new Set(trace.map((event) => String(event.kind ?? "")))
        for (const kind of spec.traceMustIncludeKinds) {
            if (!kinds.has(kind)) errors.push(`trace missing kind: ${kind}`)
        }
    }

    if (Array.isArray(spec.traceMustExcludeKinds)) {
        const kinds = new Set(trace.map((event) => String(event.kind ?? "")))
        for (const kind of spec.traceMustExcludeKinds) {
            if (kinds.has(kind)) errors.push(`trace contains excluded kind: ${kind}`)
        }
    }

    if (Array.isArray(spec.traceMustIncludeTools)) {
        const tools = new Set(
            trace
                .filter((event) => typeof event.tool === "string")
                .map((event) => String(event.tool)),
        )
        for (const tool of spec.traceMustIncludeTools) {
            if (!tools.has(tool)) errors.push(`trace missing tool call: ${tool}`)
        }
    }

    return {
        pass: errors.length === 0,
        errors,
    }
}

async function runSuite(config) {
    const suite = await loadSuite(config.suite)
    const results = []

    for (const spec of suite.cases) {
        const startedAt = new Date().toISOString()
        const startedMs = Date.now()
        let runId = null
        try {
            const start = await jsonFetch(`${config.server}/api/runs`, {
                method: "POST",
                body: JSON.stringify({ goal: spec.goal, agentId: spec.agentId }),
            })
            runId = String(start.runId)
            const run = await waitForRun(config.server, runId, config.timeoutMs, config.pollMs)
            const appliedDiff = await maybeApplyWorkspaceDiff(config.server, runId, spec)
            const trace = await jsonFetch(`${config.server}/api/runs/${runId}/trace`)
            const evaluation = evaluateCase(run, Array.isArray(trace) ? trace : [], spec)

            const applyErrors = []
            if (spec.applyWorkspaceDiff) {
                if (!appliedDiff || appliedDiff.ok !== true) {
                    applyErrors.push("workspace diff was not applied")
                }
            }

            results.push({
                id: spec.id,
                runId,
                goal: spec.goal,
                status: run.status,
                pass: evaluation.pass && applyErrors.length === 0,
                errors: [...evaluation.errors, ...applyErrors],
                workspaceDiffApply: appliedDiff,
                durationMs: Date.now() - startedMs,
                startedAt,
            })
        } catch (error) {
            results.push({
                id: spec.id,
                runId,
                goal: spec.goal,
                status: "error",
                pass: false,
                errors: [error instanceof Error ? error.message : String(error)],
                durationMs: Date.now() - startedMs,
                startedAt,
            })
        }
    }

    const passed = results.filter((r) => r.pass).length
    const summary = {
        suite: suite.name ?? "unnamed-suite",
        timestamp: new Date().toISOString(),
        server: config.server,
        total: results.length,
        passed,
        failed: results.length - passed,
        passRate: results.length > 0 ? Number((passed / results.length).toFixed(4)) : 0,
        results,
    }

    return summary
}

async function main() {
    const config = parseArgs(process.argv.slice(2))
    const summary = await runSuite(config)
    const summaryText = JSON.stringify(summary, null, 2)
    console.log(summaryText)

    if (config.output) {
        await writeFile(config.output, summaryText + "\n")
    }

    process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
})
