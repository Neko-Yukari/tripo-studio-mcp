#!/usr/bin/env node
// 登录 Tripo Studio 并把登录态（Cookie）存到 ~/.tripo/studio-state.json
// 需要一个真实浏览器：默认用已安装的 Chrome（channel: chrome）。
// 用法：npm i -D playwright && npm run login
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(os.homedir(), '.tripo');
const STATE = process.env.TRIPO_STUDIO_STATE || path.join(HOME, 'studio-state.json');
const PROFILE = process.env.TRIPO_STUDIO_PROFILE || path.join(HOME, 'profile');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('需要 playwright：npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

fs.mkdirSync(HOME, { recursive: true });

console.log('打开 Tripo Studio，请在弹出的窗口里登录（有头模式，登录后可关闭窗口）…');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: process.env.TRIPO_STUDIO_CHANNEL || 'chrome',
  viewport: { width: 1440, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://studio.tripo3d.ai/', { waitUntil: 'domcontentloaded' }).catch(() => {});

// 等出现登录态 cookie
const deadline = Date.now() + 15 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies();
  const has = cookies.some((c) => c.name === 'ory_kratos_session' && /tripo3d/.test(c.domain));
  if (has) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 3000));
}

if (!ok) {
  console.error('超时：没有拿到登录 cookie。');
  await ctx.close();
  process.exit(1);
}

await ctx.storageState({ path: STATE });
await ctx.close();
console.log('登录态已保存:', STATE);
console.log('有效期通常约一个月，过期后重新运行一次即可。');
