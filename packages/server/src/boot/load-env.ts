import { config } from "dotenv"
import { resolve } from "node:path"
import { projectRoot } from "./paths.js"

config({ path: resolve(projectRoot, ".env") })
