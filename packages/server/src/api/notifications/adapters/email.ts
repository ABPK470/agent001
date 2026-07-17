/**
 * F1.10 — Email delivery adapter.
 *
 * Uses a tiny zero-dependency SMTP-ish path: opens a TLS socket to the
 * configured server and writes the SMTP envelope by hand. This avoids
 * adding `nodemailer` (and its transitive surface) to the dependency
 * tree. If you have a corporate gateway with quirky behaviour, swap
 * this adapter out for a real client and keep the same interface.
 *
 * Config (env):
 *   SMTP_HOST       (required when route uses 'email')
 *   SMTP_PORT       default 587
 *   SMTP_USER       optional (omit for unauthenticated relay)
 *   SMTP_PASS       optional
 *   SMTP_FROM       required
 *   SMTP_USE_TLS    "1" (default) or "0"
 *
 * Delivery payload: `target` is the recipient address; body comes from
 * `renderNotificationBody(...)`.
 */

import { createConnection } from "node:net"
import { connect as tlsConnect } from "node:tls"
import type { RenderedBody } from "../service/templates.js"

export interface EmailDeliveryInput {
  target: string
  body: RenderedBody
}

export async function deliverEmail(i: EmailDeliveryInput): Promise<void> {
  const host = process.env["SMTP_HOST"]
  const from = process.env["SMTP_FROM"]
  if (!host) throw new Error("SMTP_HOST is not configured")
  if (!from) throw new Error("SMTP_FROM is not configured")
  const port = Number(process.env["SMTP_PORT"] ?? 587)
  const useTls = (process.env["SMTP_USE_TLS"] ?? "1") === "1"
  const user = process.env["SMTP_USER"] ?? null
  const pass = process.env["SMTP_PASS"] ?? null

  const dialog = await runSmtp({
    host,
    port,
    useTls,
    user,
    pass,
    from,
    to: i.target,
    subject: i.body.subject,
    text: i.body.text
  })
  if (!dialog.ok) throw new Error(`SMTP failed: ${dialog.message}`)
}

interface SmtpInput {
  host: string
  port: number
  useTls: boolean
  user: string | null
  pass: string | null
  from: string
  to: string
  subject: string
  text: string
}

async function runSmtp(i: SmtpInput): Promise<{ ok: boolean; message: string }> {
  const socket = i.useTls
    ? tlsConnect({ host: i.host, port: i.port, servername: i.host })
    : createConnection({ host: i.host, port: i.port })

  return new Promise((resolve) => {
    const buffer: string[] = []
    let step = 0
    const fail = (msg: string): void => {
      try {
        socket.destroy()
      } catch {
        /* noop */
      }
      resolve({ ok: false, message: msg })
    }
    const ok = (): void => {
      try {
        socket.destroy()
      } catch {
        /* noop */
      }
      resolve({ ok: true, message: "delivered" })
    }
    const send = (line: string): void => {
      socket.write(line + "\r\n")
    }

    socket.setEncoding("utf-8")
    socket.setTimeout(20_000, () => fail("SMTP timeout"))
    socket.on("error", (e) => fail(e.message))
    socket.on("data", (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8")
      buffer.push(text)
      const code = parseSmtpCode(text)
      if (!code) return
      if (code >= 500) return fail(`server: ${text.trim()}`)
      try {
        advance(code, send, i, step)
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
      step++
      if (step >= STEP_COUNT_END) ok()
    })
  })
}

const STEP_COUNT_END = 8

function parseSmtpCode(text: string): number | null {
  const m = text.match(/^(\d{3})/u)
  return m ? Number(m[1]) : null
}

function advance(code: number, send: (s: string) => void, i: SmtpInput, step: number): void {
  // We treat each server line as one step; this is intentionally simple
  // and only works against well-behaved relays.
  switch (step) {
    case 0: {
      // greeting
      if (code !== 220) throw new Error(`unexpected greeting: ${code}`)
      send(`EHLO ${safeHostname()}`)
      return
    }
    case 1: {
      // EHLO response
      if (i.user && i.pass) {
        send("AUTH LOGIN")
      } else {
        send(`MAIL FROM:<${i.from}>`)
      }
      return
    }
    case 2: {
      if (i.user && i.pass) {
        send(Buffer.from(i.user, "utf-8").toString("base64"))
        return
      }
      // MAIL FROM accepted → RCPT TO
      if (code !== 250) throw new Error(`MAIL FROM rejected: ${code}`)
      send(`RCPT TO:<${i.to}>`)
      return
    }
    case 3: {
      if (i.user && i.pass) {
        send(Buffer.from(i.pass, "utf-8").toString("base64"))
        return
      }
      if (code !== 250) throw new Error(`RCPT TO rejected: ${code}`)
      send("DATA")
      return
    }
    case 4: {
      if (i.user && i.pass) {
        if (code !== 235) throw new Error(`AUTH rejected: ${code}`)
        send(`MAIL FROM:<${i.from}>`)
        return
      }
      if (code !== 354) throw new Error(`DATA expected 354 got ${code}`)
      send(buildMimeMessage(i) + "\r\n.")
      return
    }
    case 5: {
      if (i.user && i.pass) {
        if (code !== 250) throw new Error(`MAIL FROM rejected: ${code}`)
        send(`RCPT TO:<${i.to}>`)
        return
      }
      if (code !== 250) throw new Error(`message rejected: ${code}`)
      send("QUIT")
      return
    }
    case 6: {
      if (i.user && i.pass) {
        if (code !== 250) throw new Error(`RCPT TO rejected: ${code}`)
        send("DATA")
        return
      }
      // QUIT response — done
      return
    }
    case 7: {
      if (i.user && i.pass) {
        if (code !== 354) throw new Error(`DATA expected 354 got ${code}`)
        send(buildMimeMessage(i) + "\r\n.")
      }
      return
    }
    case 8:
      // (only reached in AUTH path) — server accepted DATA, signal end.
      return
  }
}

function safeHostname(): string {
  return process.env["HOSTNAME"] ?? "mia.local"
}

function buildMimeMessage(i: SmtpInput): string {
  return [
    `From: ${i.from}`,
    `To: ${i.to}`,
    `Subject: ${escapeHeader(i.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    i.text.replace(/\r?\n\./g, "\r\n..") // dot-stuff
  ].join("\r\n")
}

function escapeHeader(s: string): string {
  return s.replace(/[\r\n]/g, " ")
}
