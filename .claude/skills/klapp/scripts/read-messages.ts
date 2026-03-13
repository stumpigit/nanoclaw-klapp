#!/usr/bin/env npx tsx
/**
 * Klapp - Read Messages Script
 *
 * Logs into klapp.mobi using Playwright, intercepts the REST API response
 * for messages (GET /v4/messages/parent), and returns them as JSON.
 *
 * Output: last line of stdout is the JSON result.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';

const ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const PROFILE_DIR = path.join(ROOT, 'data', 'klapp-browser-profile');
const SCREENSHOTS_DIR = path.join(ROOT, 'data', 'klapp-screenshots');
const APP_URL = 'https://klapp.mobi';
const MESSAGES_API_PATH = '/v4/messages/parent';

export interface KlappMessage {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  date: string;
  isRead: boolean;
  hasFiles: boolean;
}

interface ScriptResult {
  success: boolean;
  messages?: KlappMessage[];
  message: string;
}

function loadCredentials(): { username: string; password: string } {
  const p = path.join(ROOT, 'groups', 'global', 'secrets.env');
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) {
      const eq = t.indexOf('=');
      if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  const { KLAPP_USERNAME: username, KLAPP_PASSWORD: password } = env;
  if (!username || !password) throw new Error('KLAPP_USERNAME or KLAPP_PASSWORD not found in groups/global/secrets.env');
  return { username, password };
}

async function screenshot(page: Page, name: string): Promise<void> {
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}.png`) });
  } catch { /* ignore */ }
}

async function onLoginPage(page: Page): Promise<boolean> {
  return await page.locator('input[type="password"]').count().then(c => c > 0).catch(() => false);
}

/**
 * Set a Flutter web input value by activating its editing session first.
 * 1. mouse.click at field center to activate Flutter's text editing session
 * 2. Native value setter + 'input' event (Flutter now listening)
 */
async function setFlutterInputValue(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  const box = await input.boundingBox();
  if (!box) throw new Error(`Input not found: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await input.evaluate((el, val) => {
    const input = el as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    nativeSetter?.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(300);
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await screenshot(page, '01-login-page');
  await setFlutterInputValue(page, 'input[type="text"]', username);
  await setFlutterInputValue(page, 'input[type="password"]', password);
  await screenshot(page, '02-filled');
  const anmeldenBtn = page.locator('flt-semantics[role="button"]').filter({ hasText: /anmelden/i }).first();
  await anmeldenBtn.evaluate(el => (el as HTMLElement).click());
  await page.waitForTimeout(7000);
  await screenshot(page, '03-after-login');
}

function parseMessages(raw: unknown[], limit: number): KlappMessage[] {
  return raw.slice(0, limit).map(m => {
    const msg = m as Record<string, unknown>;
    const fromUser = (msg['from_user'] ?? {}) as Record<string, string>;
    const sender = [fromUser['first_name'], fromUser['last_name']].filter(Boolean).join(' ');
    const createdAt = (msg['created_at'] ?? msg['updated_at'] ?? msg['sent_at'] ?? '') as string;
    const date = createdAt ? new Date(createdAt).toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return {
      id: String(msg['id'] ?? ''),
      sender,
      subject: String(msg['subject'] ?? ''),
      preview: String(msg['preview'] ?? msg['content_preview'] ?? ''),
      date,
      isRead: !(msg['has_badge'] ?? false),
      hasFiles: !!(msg['has_files'] ?? false),
    };
  });
}

async function run(): Promise<ScriptResult> {
  const { username, password } = loadCredentials();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Set up response interception before navigation
    let messagesPromise: Promise<KlappMessage[]> | null = null;
    context.on('response', async (response) => {
      if (response.url().includes('api.klapp.mobi') && response.url().includes(MESSAGES_API_PATH) && !response.url().includes('/badge/')) {
        if (!messagesPromise) {
          messagesPromise = response.json().then(data => parseMessages(Array.isArray(data) ? data : [], 20)).catch(() => []);
        }
      }
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    await page.waitForFunction(
      () => document.querySelector('input') !== null || document.querySelectorAll('*').length > 200,
      { timeout: 20000 },
    ).catch(() => null);
    await page.waitForTimeout(1500);

    if (await onLoginPage(page)) {
      await login(page, username, password);
      if (await onLoginPage(page)) {
        await screenshot(page, 'login-failed');
        return { success: false, message: 'Login failed — still on login page. Check credentials or data/klapp-screenshots/ for debug info.' };
      }
      // Wait for messages API after login
      await page.waitForTimeout(4000);
    }

    // Wait for messages response (with timeout)
    const messages = await Promise.race([
      messagesPromise ?? Promise.resolve([]),
      new Promise<KlappMessage[]>(resolve => setTimeout(() => resolve([]), 10000)),
    ]);

    if (messages.length === 0) {
      return { success: false, message: 'No messages received from API. Try again or check data/klapp-screenshots/.' };
    }

    return { success: true, messages, message: `Found ${messages.length} messages` };
  } finally {
    await context.close();
  }
}

run()
  .then(result => console.log(JSON.stringify(result)))
  .catch(err => {
    console.log(JSON.stringify({ success: false, message: String(err.message ?? err) }));
    process.exit(1);
  });
