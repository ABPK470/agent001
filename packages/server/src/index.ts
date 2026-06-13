/**
 * Server entry point.
 */
import "./bootstrap/load-env.js"
import { startServer } from "./bootstrap/start-server.js"

startServer().catch((error) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
