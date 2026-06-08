/**
 * get_chart_specs — fetches the full chart-kind catalogue on demand.
 *
 * The catalogue (~120 lines / ~3K tokens) lives in
 * `loop/system-prompt.ts` as `CHART_CATALOGUE_SECTION`. The server
 * auto-injects it into the system prompt for goals that look visual
 * (`decideSections.includeChartCatalogue`); for everything else this
 * tool is the on-demand escape hatch — call it before emitting your
 * first chart fenced block when you are unsure of the JSON shape.
 *
 * Returning the catalogue verbatim is intentional: the model needs
 * the exact tag names AND the example JSON shapes to produce a
 * renderer-compatible payload.
 */

import { CHART_CATALOGUE_SECTION, renderPromptVars } from "../application/shell/loop.js"
import type { Tool, ToolMetadata } from "../domain/agent-types.js"

export const getChartSpecsToolMetadata: ToolMetadata = {
  name: "get_chart_specs",
  description:
    "Return the full reference for every supported chart fenced-block kind " +
    "(bar, line, area, pie, donut, scatter, heatmap, kpi, relationships, " +
    "flow, dashboard) including the exact JSON shape and a worked example. " +
    "Call this once at the start of any answer that emits a chart fenced " +
    "block when the catalogue is not already in your context.",
  parameters: {
    type: "object",
    properties: {}
  }
}

export const getChartSpecsTool: Tool = {
  ...getChartSpecsToolMetadata,

  async execute() {
    return renderPromptVars(CHART_CATALOGUE_SECTION)
  }
}
