/**
 * Page-content helpers: cookie-consent dismissal and text extraction.
 *
 * @module
 */

/** Try to auto-dismiss common cookie consent banners. */
export async function dismissCookieConsent(page: import("puppeteer").Page): Promise<void> {
  try {
    // Runs in browser context — use string eval to avoid DOM type issues in Node tsconfig
    await page.evaluate(`(() => {
      const patterns = [
        /^accept$/i, /^accept all$/i, /^accept cookies$/i,
        /^i agree$/i, /^i understand$/i, /^agree$/i,
        /^ok$/i, /^got it$/i, /^allow$/i, /^allow all$/i,
        /^souhlasím$/i, /^přijmout$/i, /^přijmout vše$/i, /^rozumím$/i,
      ];
      const btns = document.querySelectorAll(
        'button, a[role="button"], [class*="cookie"] button, [class*="consent"] button, ' +
        '[id*="cookie"] button, [id*="consent"] button, [class*="Cookie"] button, [class*="Consent"] button'
      );
      for (const btn of btns) {
        const text = btn.innerText?.trim();
        if (text && patterns.some(p => p.test(text))) { btn.click(); return; }
      }
    })()`)
    await new Promise(r => setTimeout(r, 1000))
  } catch { /* ignore */ }
}

/** Extract readable text from current page. */
export async function readPageText(page: import("puppeteer").Page, maxLength: number): Promise<string> {
  let text = String(await page.evaluate('document.body?.innerText ?? ""'))
  text = text.replace(/\s+/g, " ").trim()
  if (text.length > maxLength) text = text.slice(0, maxLength) + "\n... (truncated)"
  return text || "(empty page)"
}
