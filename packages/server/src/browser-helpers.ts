/**
 * Browser sandbox helpers.
 *
 * Builds the self-contained Node.js script that runs inside the Docker browser
 * container (puppeteer + Chromium), and formats the JSON output into a readable report.
 */

// ── Script builder ────────────────────────────────────────────────

/**
 * Build a self-contained Node.js script that runs inside the browser container.
 * The script:
 *   1. Starts a static file server on a random port inside the container
 *   2. Launches Chromium via Puppeteer (container-installed)
 *   3. Navigates to the HTML file
 *   4. Collects errors for the specified wait time
 *   5. Performs any requested clicks
 *   6. Outputs a JSON result to stdout
 */
export function buildBrowserScript(htmlPath: string, clicks: string[], waitMs: number): string {
  const esc = (s: string) => JSON.stringify(s)
  return `
const http = require("http");
const fs = require("fs");
const path = require("path");
let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch {
  try {
    puppeteer = require("/usr/local/lib/node_modules/puppeteer");
  } catch {
    puppeteer = require("/usr/lib/node_modules/puppeteer");
  }
}

const MIME = {
  ".html": "text/html", ".htm": "text/html", ".js": "application/javascript",
  ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

async function main() {
  const htmlPath = ${esc(htmlPath)};
  const clicks = ${JSON.stringify(clicks)};
  const waitMs = ${waitMs};

  const fullPath = path.join("/workspace", htmlPath);
  const dir = path.dirname(fullPath);
  const fileName = path.basename(fullPath);

  // Static file server
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const relPath = (urlPath === "/" ? "index.html" : urlPath.replace(/^\\/+/, "")) || "index.html";
    const filePath = path.join(dir, relPath);
    if (!filePath.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end("Not found"); }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(null));
    server.on("error", reject);
  });
  const port = server.address().port;

  const consoleErrors = [];
  const consoleWarnings = [];
  const networkErrors = [];
  const uncaughtErrors = [];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run"],
    });
    const page = await browser.newPage();

    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        const loc = msg.location();
        const errUrl = loc?.url || "";
        if (text.includes("Failed to load resource") && /favicon|apple-touch-icon/i.test(errUrl)) {
          // skip non-critical
        } else if (text.includes("Failed to load resource") && errUrl) {
          consoleErrors.push(text + " — URL: " + errUrl);
        } else {
          consoleErrors.push(text);
        }
      }
      else if (type === "warn") consoleWarnings.push(text);
    });
    page.on("pageerror", (err) => uncaughtErrors.push(String(err)));
    page.on("requestfailed", (req) => {
      const reqUrl = req.url();
      if (/favicon|apple-touch-icon/i.test(reqUrl)) return;
      networkErrors.push((req.failure()?.errorText || "failed") + ": " + reqUrl);
    });

    await page.goto("http://127.0.0.1:" + port + "/" + fileName, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });

    await new Promise(r => setTimeout(r, waitMs));

    for (const selector of clicks) {
      try {
        await page.click(selector);
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        consoleErrors.push("Click failed on " + JSON.stringify(selector) + ": " + err.message);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  const result = { consoleErrors, consoleWarnings, networkErrors, uncaughtErrors };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err.message || String(err));
  process.exit(1);
});
`.trim()
}

// ── Report formatter ──────────────────────────────────────────────

/** Format the JSON result from the container browser script into a readable report. */
export function formatBrowserReport(parsed: {
  consoleErrors?: string[]
  consoleWarnings?: string[]
  networkErrors?: string[]
  uncaughtErrors?: string[]
}): string {
  const consoleErrors = parsed.consoleErrors ?? []
  const consoleWarnings = parsed.consoleWarnings ?? []
  const networkErrors = parsed.networkErrors ?? []
  const uncaughtErrors = parsed.uncaughtErrors ?? []
  const totalErrors = consoleErrors.length + uncaughtErrors.length + networkErrors.length

  if (totalErrors === 0 && consoleWarnings.length === 0) {
    return "✓ No errors or warnings detected."
  }

  const lines: string[] = []
  if (uncaughtErrors.length > 0) {
    lines.push(`## Uncaught Exceptions (${uncaughtErrors.length})`)
    for (const e of uncaughtErrors) lines.push(`  - ${e}`)
  }
  if (consoleErrors.length > 0) {
    lines.push(`## Console Errors (${consoleErrors.length})`)
    for (const e of consoleErrors) lines.push(`  - ${e}`)
  }
  if (networkErrors.length > 0) {
    lines.push(`## Network Failures (${networkErrors.length})`)
    for (const e of networkErrors) lines.push(`  - ${e}`)
  }
  if (consoleWarnings.length > 0) {
    lines.push(`## Warnings (${consoleWarnings.length})`)
    for (const w of consoleWarnings) lines.push(`  - ${w}`)
  }
  lines.push("")
  lines.push(`Total: ${totalErrors} error(s), ${consoleWarnings.length} warning(s)`)
  return lines.join("\n")
}
