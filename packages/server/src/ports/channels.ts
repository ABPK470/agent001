export interface MessageRouterPort {
  sendReply(runId: string, text: string): Promise<void>
}
