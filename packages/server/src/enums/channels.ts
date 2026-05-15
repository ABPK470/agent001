/**
 * Server-only enums for the `channels` domain.
 */

/** Messaging platform identifier for a Channel. */
export const ChannelType = {
  Teams: "teams",
} as const

export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType]

export const CHANNEL_TYPES: ReadonlyArray<ChannelType> = Object.values(ChannelType)

export const isChannelType = (value: unknown): value is ChannelType =>
  typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value)

/** Lifecycle of an outbound message in the delivery queue. */
export const DeliveryStatus = {
  Queued:    "queued",
  Sending:   "sending",
  Delivered: "delivered",
  Failed:    "failed",
  Retrying:  "retrying",
} as const

export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus]

export const DELIVERY_STATUSES: ReadonlyArray<DeliveryStatus> = Object.values(DeliveryStatus)

export const isDeliveryStatus = (value: unknown): value is DeliveryStatus =>
  typeof value === "string" && (DELIVERY_STATUSES as readonly string[]).includes(value)
