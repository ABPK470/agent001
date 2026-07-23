/**
 * HTTP port for sync flow steps — injected at execute/preview composition roots.
 */

export interface HttpJsonResponse {
  readonly status: number
  readonly responseBody: Record<string, unknown> | null
}

export interface HttpPort {
  json(
    method: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<HttpJsonResponse>
}
