import { chromium } from "playwright";

const BASE = "http://localhost:5173";

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Go to login page and sign in
  await page.goto(BASE);
  await page.waitForSelector(".loginSubmit");

  // Screenshot login page
  await page.screenshot({ path: "imgs/login.png" });

  // Login with default credentials (already pre-filled)
  await page.click(".loginSubmit");
  await page.waitForSelector(".sidebar");
  await page.waitForTimeout(1000);

  // Click on #general to make sure we're there
  await page.click('button.channel:has-text("#general")');
  await page.waitForTimeout(500);

  // Open a thread by clicking on the message with replies
  const threadBtn = page.locator('.threadButton:has-text("2 replies")').first();
  if (await threadBtn.isVisible()) {
    await threadBtn.click();
    await page.waitForTimeout(500);
  }

  // Screenshot chat workspace with thread open
  await page.screenshot({ path: "imgs/chat-overview.png" });

  // Close thread
  const closeBtn = page.locator('.ghostButton:has-text("Close")');
  if (await closeBtn.isVisible()) {
    await closeBtn.click();
    await page.waitForTimeout(300);
  }

  // Go to admin tab
  await page.click('button.tabButton:has-text("Admin")');
  await page.waitForTimeout(800);

  // Screenshot admin board
  await page.screenshot({ path: "imgs/admin-board.png" });

  await browser.close();
  console.log("Screenshots saved to imgs/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
