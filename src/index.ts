import { createApp } from "./api/app.js"

const app = createApp()
const port = Number(process.env["PORT"] ?? 3000)
const host = process.env["HOST"] ?? "0.0.0.0"

app.listen({ port, host }).then((address) => {
  console.log(`agent001 listening on ${address}`)
})
