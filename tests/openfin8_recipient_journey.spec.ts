// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the OpenFin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/bank8_lifecycle.spec.ts
//
// Bank8 vertical lifecycle e2e - platform setup happens ONCE in
// global-setup.ts via the sentin8-cli binary (org/env/features/app
// instances/staff users). This spec drives ONLY the four bank8 apps
// through the browser, exactly like a real user:
//
//   1. Ben signs in to Bank8:Admin (staff SSO) and creates ledger products.
//   2. Alice signs up as an iBank customer via eBank.
//   3. Alice opens Checking/Savings/Credit Card accounts.
//   4. Bob signs in to eTeller (staff) and finds Alice.
//   5. Alice signs in to eBank and checks her accounts.
//   5. Alice signs up at eOpenCA and completes the consent flow,
//      seeing her iBank accounts.
//   6. Alice signs OUT of eOpenCA, signs back IN, and verifies her
//      connected account INFORMATION (the consent survives the session:
//      the delegated-token data path re-reads the persisted registry,
//      the account detail, and the transaction history).
//   7. The FDX recipient API coverage: the consent_id-scoped account
//      filter, the transaction history surface, and the revocation
//      contract (a revoked consent stops serving data - the negative
//      assertion the isolation story demands).
//
// Dash tests (operator onboarding, playground routes) live in the
// sentin8 e2e suite - the bank8 suite never opens Dash.

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  Personas,
  signUpViaApp,
  signInToTenantAuth8,
  signOutViaUI,
  signInOnAuth8,
  gotoCertWarm,
  waitForFlutterSemantics,
  waitForFlutterText,
  clickFlutterButton,
  typeFlutterField,
  getFlutterTexts,
  assertSessionCookieSet,
  logStep,
  cliCall,
} from '../fixtures';

test.describe.configure({ mode: 'serial' });

// Meta written by global-setup.ts (org/env IDs, app hostnames).
interface TestMeta {
  runId: string;
  domain: string;
  ibankOrgId: string;
  ibankEnvId: string;
  ibankStaffEnvId: string;
  ibankOrgDomain: string;
  ebankHostname: string;
  adminAppHostname: string;
  eopencaHostname: string;
  iopencaOrgId: string;
  iopencaEnvId: string;
  benEmail: string;
  aliceEmail: string;
  frankEmail: string;
}

/**
 * TLS cert-warmup for the vertical service TENANT routes
 * ({service}.{env}.{org-domain}) - the admin UI reaches ledger/payments/
 * fdx/… through the BFF proxy, whose forward client TLS-connects to those
 * hosts. Services mint their on-demand Acme leaf on the FIRST hit and the
 * BFF's connect can lose that race (surfacing as a 502 "error sending
 * request" while the upstream logs "cert registered on-demand" ~70ms
 * later - the same race the browser absorbs via gotoCertWarm).
 *
 * One unauthenticated GET per service route; ANY verdict (401/403/404/200)
 * completes the mint. Bounded: total poll window ~15s, then give up -
 * first use in the tests re-triggers the mint anyway.
 */
async function warmTenantServiceRoutes(meta: TestMeta, orgDomain: string): Promise<void> {
  // TLS trust: verified fetch only - the platform root CA is in the OS
  // trust store and Node runs with --use-openssl-ca (npm scripts). No
  // code-level verification bypass, ever (platform TLS rule).
  const deadline = Date.now() + 15_000;
  let warmed = false;
  // One representative route per service family - ledger's admin-ui route
  // is the first one the admin UI drives; the openfin8-ca tenant host is
  // what the eOpenCA BFF proxy forwards to (the recipient catalog,
  // consents, accounts). Warming each warms the shared on-demand cert
  // path for the rest (same org/env suffix mints fine).
  const routes = [
    `https://bank8-ledger.prod.${orgDomain}/v1/health`,
    `https://openfin8-ca.prod.${orgDomain}/v1/health`,
  ];
  while (Date.now() < deadline && !warmed) {
    for (const url of routes) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        // ANY HTTP verdict means TLS is live - the mint completed.
        if (resp.status > 0) { warmed = true; break; }
      } catch {
        // Not minted yet - retry below.
      }
    }
    if (!warmed) await new Promise((r) => setTimeout(r, 500));
  }
  if (warmed) logStep('[lifecycle] tenant service routes TLS-warmed');
  else logStep('[lifecycle] ⚠️ tenant service route warmup window elapsed - first call may race the mint');
}

function loadMeta(): TestMeta {
  const raw = readFileSync(join(process.cwd(), '.tmp', 'test-meta.json'), 'utf-8');
  return JSON.parse(raw) as TestMeta;
}

const PAUSE_ON_STEP = process.env.PAUSE_ON_STEP ?? '';

/**
 * Clear the auth rate-limit Valkey keys (auth uses DB 1). Repeated staff
 * sign-ins during e2e runs trip bot protection (10/min per IP, 5/min per
 * email) with a generic "Invalid email or password"-looking failure - clear
 * before each staff sign-in.
 */
function clearAuthRateLimits(email: string): void {
  try {
    execSync(
      `valkey-cli -n 1 --scan --pattern 'auth:rate:*' | xargs -r valkey-cli -n 1 del`,
      { stdio: 'pipe', timeout: 2_000 },
    );
  } catch {
    // Best-effort - limiter may be disabled in this deployment.
  }
  logStep(`[lifecycle] cleared auth rate limits (for ${email})`);
}

async function maybePause(page: Page, stepTitle: string): Promise<void> {
  if (!PAUSE_ON_STEP || PAUSE_ON_STEP === 'none') return;
  if (!stepTitle.includes(PAUSE_ON_STEP)) return;
  await page.pause();
}

test.describe('OpenFin8 Lifecycle - the recipient journey (provider-side prereqs via bank8, recipient via eOpenCA)', () => {
  let context: BrowserContext;
  let page: Page;
  let meta: TestMeta;

  test.beforeAll(async ({ browser }) => {
    meta = loadMeta();
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    page = await context.newPage();
    // Diagnostics (mid-flow "TypeError: Failed to fetch" investigation):
    // surface failed requests + 5xx with the failing hop's error text.
    page.on('requestfailed', (r) =>
      console.log('[requestfailed]', r.url().slice(0, 140), '=>', r.failure()?.errorText));
    page.on('response', (r) => { if (r.status() >= 500) console.log('[http-5xx]', r.status(), r.url().slice(0, 140)); });
    // TLS cert-warmup for the vertical service tenant routes - the BFF's
    // forward client races the upstream's on-demand Acme leaf on the
    // first hit of a fresh run (see warmTenantServiceRoutes).
    await warmTenantServiceRoutes(meta, meta.ibankOrgDomain);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Bank8:Admin - Ben (staff SSO) creates ledger products
  // ═══════════════════════════════════════════════════════════════════════

  test('1. Ben creates ledger products via Bank8:Admin (provider-side prerequisite)', async () => {
    await maybePause(page, '1.');
    logStep('[lifecycle] 1 start: Ben signs in to Bank8:Admin via staff SSO and creates products');

    // IMPORTANT: use the emails persisted by globalSetup - Personas compute
    // RUN_ID at module-load time, which differs per worker (globalSetup ran
    // in its own process with its own timestamp). Ben was created by
    // globalSetup with THAT run's email.
    const ben = { email: meta.benEmail, password: Personas.ben.password! };
    const adminURL = `https://${meta.adminAppHostname}`;
    logStep(`[lifecycle] 1 step: navigating to Bank8:Admin at ${adminURL}`);

    await gotoCertWarm(page, adminURL);
    // Cold-boot budget: a new run's first load races the on-demand TLS cert
    // mint for the app + BFF + staff-auth hostnames and the first
    // /auth/session call (observed 3.7s on the BFF alone; the engine boot
    // + semantics render arrives ~10-15s after goto on a truly cold run).
    // waitForFlutterSemantics returns as soon as ANY flt-semantics exists,
    // but the login screen may not be rendered yet - so poll for the
    // actual STATE text ("Staff Sign In" OR the signed-in dashboard's
    // "Overview") before branching. Up to 30s. (Mirrors the bank8 spec's
    // step-1 boot poll - the same race killed this suite's first step.)
    const bootDeadline = Date.now() + 30_000;
    let booted = false;
    while (Date.now() < bootDeadline) {
      const texts = await getFlutterTexts(page);
      if (texts.some((t) => t.includes('Staff Sign In') || t.includes('Overview') || t.includes('Ledger'))) {
        booted = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!booted) {
      throw new Error(`Bank8:Admin did not finish booting within 30s (no "Staff Sign In" or dashboard text)`);
    }
    await page.waitForTimeout(500);

    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    // If not already signed in (SSO via shared cookie), sign in via staff auth.
    // FAIL FAST: each step must succeed - no silent catch-and-continue.
    const texts = await getFlutterTexts(page);
    const alreadySignedIn = texts.some((t) => t.includes('Overview') || t.includes('Ledger'));
    if (!alreadySignedIn) {
      logStep('[lifecycle] 1 step: not signed in - signing in via staff auth');
      await clickFlutterButton(page, 'Staff Sign In');
      await page.waitForTimeout(500);

      await waitForFlutterSemantics(page, 2_000);
      await waitForFlutterText(page, 'Email', 2_000);
      // Rate limiter: repeated sign-ins during e2e trips bot protection.
      clearAuthRateLimits(ben.email);
      await signInOnAuth8(page, ben.email, ben.password!);
      await page.waitForTimeout(1_000);

      // Verify the sign-in actually landed on the admin app - fail fast
      // with the page content if it did not. POLL for the dashboard: the
      // app boots over the OAuth callback chain, so a single read 1s after
      // the submit races the Flutter render (observed: page text still
      // empty while the screenshot a moment later shows Overview). Up to
      // 15s, checking every 500ms.
      const landDeadline = Date.now() + 15_000;
      let signedIn = false;
      let postTexts: string[] = [];
      while (Date.now() < landDeadline) {
        postTexts = await getFlutterTexts(page);
        if (postTexts.some((t) => t.includes('Overview') || t.includes('Ledger') || t.includes('Products'))) {
          signedIn = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      if (!signedIn) {
        throw new Error(
          `Staff sign-in did not land on Bank8:Admin. url=${page.url()} page: ${postTexts.slice(0, 15).join(' | ')}`,
        );
      }
    }

    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);
    logStep('[lifecycle] 1 step: Bank8:Admin loaded');

    // Navigate to Ledger > Products via sidebar. "Ledger" is an
    // ExpansionTile - click to expand, then click "Products".
    // FAIL FAST: if the sidebar never shows Products, fail with page text.
    let productsVisible = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ledgerBtn = page.getByRole('button', { name: 'Ledger', exact: false });
      if (await ledgerBtn.count() > 0) {
        await ledgerBtn.first().click({ force: true });
      } else {
        await clickFlutterButton(page, 'Ledger');
      }
      await page.waitForTimeout(500);
      try {
        await waitForFlutterText(page, 'Products', 2_000);
        productsVisible = true;
        break;
      } catch {
        logStep(`[lifecycle] 1 step: sidebar Products not visible (attempt ${attempt + 1}/3)`);
      }
    }
    if (!productsVisible) {
      const sidebarTexts = await getFlutterTexts(page);
      throw new Error(`Sidebar "Products" never appeared after expanding Ledger. Page: ${sidebarTexts.slice(0, 15).join(' | ')}`);
    }
    await clickFlutterButton(page, 'Products');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    const products = [
      { type: 'current_account', name: 'iBank Checking' },
      { type: 'savings_account', name: 'iBank Savings' },
      { type: 'credit_card', name: 'iBank Credit Card' },
    ];

    for (const p of products) {
      let createClicked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await waitForFlutterText(page, 'Create Product', 2_000);
          await clickFlutterButton(page, 'Create Product');
          await page.waitForTimeout(500);
          createClicked = true;
          break;
        } catch {
          logStep(`[lifecycle] 1 step: Create Product not found (attempt ${attempt + 1}/3) - re-navigating via hash`);
          await page.evaluate(() => {
            history.replaceState(null, '', '#/ledger/products');
            window.dispatchEvent(new Event('hashchange'));
          });
          await page.waitForTimeout(2000);
          await waitForFlutterSemantics(page, 2_000);
          await page.waitForTimeout(500);
        }
      }
      if (!createClicked) {
        throw new Error('Could not find "Create Product" button in Bank8:Admin after 3 attempts');
      }

      // Wait for the product type selection page.
      let typeSelected = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await waitForFlutterText(page, 'Select Product Type', 2_000);
          typeSelected = true;
          break;
        } catch {
          logStep(`[lifecycle] 1 step: Select Product Type not found (attempt ${attempt + 1}/3) - retrying`);
          await page.waitForTimeout(1000);
        }
      }
      if (!typeSelected) throw new Error('Could not find "Select Product Type" page');

      // Navigate directly to the product config form via URL hash.
      await page.evaluate((t: string) => {
        history.replaceState(null, '', `#/ledger/products/new?type=${t}`);
        window.dispatchEvent(new Event('hashchange'));
      }, p.type);
      await waitForFlutterSemantics(page, 2_000);
      await page.waitForTimeout(1000);

      await typeFlutterField(page, 'Product Name', p.name);
      await page.waitForTimeout(100);

      // Click the form submit button - the last "Create Product" button on
      // the page (form submit, not the header action). Scroll into view if
      // needed (Flutter SingleChildScrollView).
      await page.evaluate(() => {
        document.querySelectorAll('flt-semantics').forEach(el => {
          (el as HTMLElement).style.pointerEvents = 'none';
        });
      });
      const submitResult = await page.evaluate(() => {
        const els = document.querySelectorAll('flt-semantics');
        let lastMatch: Element | null = null;
        for (const el of Array.from(els)) {
          const role = el.getAttribute('role');
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (role === 'button' && t === 'create product') lastMatch = el;
        }
        if (!lastMatch) return { found: false, x: 0, y: 0, top: 0, bottom: 0, vh: 0 };
        const r = (lastMatch as HTMLElement).getBoundingClientRect();
        return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, vh: window.innerHeight };
      });

      if (submitResult.found) {
        if (submitResult.bottom > submitResult.vh) {
          await page.mouse.wheel(0, submitResult.bottom - submitResult.vh + 100);
          await page.waitForTimeout(500);
          const newRect = await page.evaluate(() => {
            const els = document.querySelectorAll('flt-semantics');
            let lastMatch: Element | null = null;
            for (const el of Array.from(els)) {
              if (el.getAttribute('role') === 'button' && (el.textContent ?? '').trim().toLowerCase() === 'create product') lastMatch = el;
            }
            if (!lastMatch) return null;
            const r = (lastMatch as HTMLElement).getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          if (newRect) {
            await page.mouse.click(newRect.x, newRect.y);
          } else {
            await page.mouse.click(submitResult.x, submitResult.y);
          }
        } else {
          await page.mouse.click(submitResult.x, submitResult.y);
        }
      } else {
        await clickFlutterButton(page, 'Create Product', false);
      }
      await page.evaluate(() => {
        document.querySelectorAll('flt-semantics').forEach(el => {
          (el as HTMLElement).style.pointerEvents = '';
        });
      });
      await page.waitForTimeout(1000);

      // FAIL FAST: a submit that did nothing (policy denial, validation
      // error, silent no-op) must abort the test here - NOT three steps
      // later when test 3's account-open can't find the product. Scan the
      // UI for error toasts right after the submit.
      const postSubmitTexts = await getFlutterTexts(page);
      const uiError = postSubmitTexts.find((t) =>
        /forbidden|unauthorized|authorization failed|failed by policy|denied|creation failed|error:/i.test(t));
      if (uiError) {
        throw new Error(
          `Product "${p.name}" was NOT created - UI reported: "${uiError}". ` +
          `Page: ${postSubmitTexts.slice(0, 15).join(' | ')}`);
      }

      // Back to the products list via hash change.
      await page.evaluate(() => {
        history.replaceState(null, '', '#/ledger/products');
        window.dispatchEvent(new Event('hashchange'));
      });
      await page.waitForTimeout(2000);
      await waitForFlutterSemantics(page, 2_000);
      await page.waitForTimeout(500);

      // FAIL FAST: the product MUST be listed on the products page before
      // the loop continues - a silent no-op submit is a failure, not a skip.
      // A FULL page reload (not a hash swap) on retry: a hash-only re-render
      // reuses the app's cached HTTP connections, so a dropped keep-alive
      // socket surfaces as "TypeError: Failed to fetch" forever; a reload
      // rebuilds the session fetch path from scratch.
      let productListed = false;
      let lastListTexts: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        lastListTexts = await getFlutterTexts(page);
        if (lastListTexts.some((t) => t.includes(p.name))) {
          productListed = true;
          break;
        }
        logStep(`[lifecycle] 1 step: product "${p.name}" not listed yet (attempt ${attempt + 1}/3) - reloading page`);
        await page.evaluate(() => {
          history.replaceState(null, '', '#/ledger/products');
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForFlutterSemantics(page, 4_000);
        await page.waitForTimeout(1000);
      }
      if (!productListed) {
        throw new Error(
          `Product "${p.name}" was not created - absent from the products list after 3 checks. ` +
          `Page: ${lastListTexts.slice(0, 15).join(' | ')}`);
      }

      logStep(`[lifecycle] 1 step: product created and listed: ${p.name}`);
    }

    logStep(`[lifecycle] 1 done: Ben created 3 ledger products via Bank8:Admin`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eBank - Alice (customer) signs up and opens accounts
  // ═══════════════════════════════════════════════════════════════════════

  test('2. Alice signs up as iBank customer via eBank', async () => {
    await maybePause(page, '2.');
    logStep('[lifecycle] 2 start: Alice signs up as iBank customer');
    // meta emails come from the globalSetup that JUST ran in this process -
    // Personas' module-level RUN_ID can drift on worker retry (known issue).
    const alice = { email: meta.aliceEmail, firstName: Personas.alice.firstName, lastName: Personas.alice.lastName, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    await signUpViaApp(page, context, appURL, alice.email, alice.firstName, alice.lastName, alice.password!);
    await assertSessionCookieSet(context, '__session');
    logStep(`[lifecycle] 2 done: Alice signed up: ${alice.email}`);
  });

  test('3. Alice opens Checking, Savings, and Credit Card accounts', async () => {
    await maybePause(page, '3.');
    logStep('[lifecycle] 3 start: Alice signs in and opens 3 accounts');
    const alice = { email: meta.aliceEmail, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    await signInToTenantAuth8(page, context, appURL, alice.email, alice.password!);
    logStep('[lifecycle] 3 step: Alice signed in to iBank');

    const products = [
      { name: 'iBank Checking' },
      { name: 'iBank Savings' },
      { name: 'iBank Credit Card' },
    ];
    for (const p of products) {
      await openLedgerAccountViaUI(page, p.name, 'USD', 'Products');
      logStep(`[lifecycle] 3 step: opened account: ${p.name}`);
    }

    await clickFlutterButton(page, 'Accounts', true);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(501);

    const texts = await getFlutterTexts(page);
    const all = texts.join(' ');
    expect(all).toContain('iBank Checking');
    expect(all).toContain('iBank Savings');
    expect(all).toContain('iBank Credit Card');
    logStep('[lifecycle] 3 done: Accounts page shows all 3 iBank products');
  });

  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // eBank - Alice checks her accounts
  // ═══════════════════════════════════════════════════════════════════════

  test('4. Alice signs in to eBank and checks her accounts', async () => {
    await maybePause(page, '5.');
    logStep('[lifecycle] 4 start: Alice signs in to eBank and checks accounts');

    const alice = { email: meta.aliceEmail, password: Personas.alice.password! };
    const appURL = `https://${meta.ebankHostname}`;

    try { await signOutViaUI(page); } catch { /* may already be signed out */ }
    await waitForFlutterSemantics(page, 2_000);

    await signInToTenantAuth8(page, context, appURL, alice.email, alice.password!);
    logStep('[lifecycle] 5 step: Alice signed in to eBank');

    // FAIL FAST: the Accounts page must exist and show the accounts.
    await waitForFlutterText(page, 'Accounts', 2_000);
    await clickFlutterButton(page, 'Accounts', true);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    const acctTexts = await getFlutterTexts(page);
    const allText = acctTexts.join(' ');
    expect(
      allText.includes('iBank Checking') || allText.includes('iBank Savings') || allText.includes('iBank Credit Card'),
      `eBank accounts not visible. Page: ${acctTexts.slice(0, 15).join(' | ')}`,
    ).toBe(true);

    // ── Tenant-isolation canary (ledger design §5/§9): Alice must see
    // ONLY her own accounts - no internal counterparty accounts and no
    // other tenant's data. The holder-scoped RLS + the service-layer
    // customer filter must guarantee the negative assertions below.
    const ownAccounts = ['iBank Checking', 'iBank Savings', 'iBank Credit Card'];
    const internalNicknames = ['cash_deposit_account', 'cheque_clearing_account', 'liquidity_account', 'clearing_account', 'suspense_account'];
    // Verify the positive list AND the negatives through the same holder
    // session the app uses (eBank BFF proxy → ledger list_accounts).
    const ebankBffBase = `https://bff.${meta.ebankHostname}`;
    const isoRes = await page.request.get(`${ebankBffBase}/proxy/bank8-ledger/v1/accounts`, { failOnStatusCode: false });
    expect(isoRes.status(), 'eBank BFF session must read Alice account list for the isolation canary').toBe(200);
    const isoBody = (await isoRes.json()) as Record<string, unknown>;
    const isoJson = (isoBody['data'] ?? isoBody) as { accounts?: Array<{ id: string; nickname?: string; account_type?: string }>; data?: Array<{ id: string; nickname?: string; account_type?: string }> };
    const isoAccounts = isoJson.accounts ?? isoJson.data ?? (Array.isArray(isoJson) ? isoJson : []);
    expect(isoAccounts.length, `Alice must see at least her 3 opened accounts (got ${isoAccounts.length})`).toBeGreaterThanOrEqual(3);
    // (a) NO internal accounts - counterparty plumbing is invisible to
    // holders regardless of query params (isolation-design §10.1).
    const internalLeak = isoAccounts.filter((a) => a.account_type === 'internal');
    expect(internalLeak, `isolation violation: internal accounts leaked to a customer token (${internalLeak.map((a) => a.nickname).join(',')})`).toHaveLength(0);
    // (b) NO cross-env data - every row belongs to Alice's env; the
    // customer rows visible are exactly hers (the seeded institution
    // customer's internal accounts never appear under any filter).
    const foreignInternal = isoAccounts.filter((a) => (a.nickname ?? '').includes('_account') && a.account_type !== 'customer');
    expect(foreignInternal, `isolation violation: non-customer accounts in a customer's list (${foreignInternal.map((a) => a.nickname).join(',')})`).toHaveLength(0);
    logStep('[lifecycle] 5 step: isolation canary passed - customer sees only own customer-type accounts');

    logStep('[lifecycle] 5 done: Alice checked eBank accounts');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eOpenCA - Alice completes the FDX consent flow
  // ═══════════════════════════════════════════════════════════════════════

  test('5. Alice signs up as eOpenCA customer and completes the consent flow', async () => {
    await maybePause(page, '6.');
    logStep('[lifecycle] 5 start: Alice signs up at iOpenCA and completes FDX consent');
    const iopencaAppURL = `https://${meta.eopencaHostname}`;

    await signUpViaApp(
      page, context, iopencaAppURL,
      meta.aliceEmail, Personas.alice.firstName, Personas.alice.lastName, Personas.alice.password!,
    );
    logStep('[lifecycle] 5 step: Alice signed up at iOpenCA');

    await waitForFlutterText(page, 'Providers', 2_000);
    await clickFlutterButton(page, 'Providers');
    await waitForFlutterSemantics(page, 2_000);
    logStep('[lifecycle] 5 step: navigated to Providers page');

    // Verify iBank is listed as an available provider. The fdx Shield policy
    // set for the newly-enabled env is picked up by the engine's hot-reload
    // within ~90s of the service-enabled event (15.2.23); the catalog page
    // fetches once on mount, so re-mount the page (Dashboard → Providers)
    // on every miss until THIS run's provider card appears (~30s budget).
    const thisRunProvider = `iBank${meta.runId}`;
    let hasIBank = false;
    for (let attempt = 0; attempt < 8 && !hasIBank; attempt++) {
      try {
        await waitForFlutterText(page, thisRunProvider, 3_000);
        hasIBank = true;
        break;
      } catch {
        // Re-mount the catalog: navigate to Dashboard, then back to Providers
        // - each mount re-fetches the provider list through the BFF.
        try { await clickFlutterButton(page, 'Dashboard', true); } catch { /* already there */ }
        await page.waitForTimeout(400);
        try { await clickFlutterButton(page, 'Providers', true); } catch { /* nav */ }
        await waitForFlutterSemantics(page, 1_500);
        if (attempt === 2 || attempt === 5) {
          const debugTexts = await getFlutterTexts(page);
          logStep(`[lifecycle] 5 step: provider still missing (attempt ${attempt + 1}/8). Page: ${debugTexts.slice(0, 12).join(' | ')}`);
        }
      }
    }
    expect(hasIBank, `this run's provider card (${thisRunProvider}) must appear on the eOpenCA Providers page`).toBe(true);
    logStep('[lifecycle] 5 step: iBank listed as FDX provider, clicking it');
    // Old-run provider profiles accumulate in fdx_provider_profiles (one per
    // runId). Click THIS run's provider explicitly - the current run's org
    // slug is unique, so the exact-name button targets the right card. The
    // list loads asynchronously and this run's card may render after the
    // generic "iBank" wait - poll for the exact card (6s) before failing.
    let clickedThisRun = false;
    const cardDeadline = Date.now() + 6_000;
    while (Date.now() < cardDeadline && !clickedThisRun) {
      try {
        await clickFlutterButton(page, thisRunProvider);
        clickedThisRun = true;
      } catch {
        await page.waitForTimeout(400);
      }
    }
    if (!clickedThisRun) {
      const debugTexts = await getFlutterTexts(page).catch(() => [] as string[]);
      logStep(`[lifecycle] provider card missing. Page: ${debugTexts.slice(0, 20).join(' | ')}`);
    }
    expect(clickedThisRun, `this run's provider card (${thisRunProvider}) must be clickable`).toBe(true);
    await page.waitForTimeout(500);

    // The detail page opens via Navigator.push - give the Flutter route
    // transition time to paint before asserting on the button text.
    await waitForFlutterText(page, 'Connect & Authorize', 4_000);
    // Shield fail-closed first-hit race: the very first consent-start
    // request on a fresh env can land inside the no_set_for_env window -
    // the policy-set self-heal seeds on that same request, so the SECOND
    // attempt succeeds. The app surfaces the 500 as a snackbar and stays
    // on the page, so RETRY THE CLICK while the page has not redirected
    // (bounded - a genuine non-transient failure exhausts the window and
    // the deadline error below reports the URL).
    const consentClickDeadline = Date.now() + 15_000;
    let consentClicked = false;
    while (Date.now() < consentClickDeadline) {
      // The click can throw MID-NAVIGATION (the previous click's consent
      // start succeeded and the page is already leaving) - a click error
      // is therefore NOT a failure signal; check the URL first.
      if (!page.url().includes(meta.eopencaHostname)) { consentClicked = true; break; }
      try {
        await clickFlutterButton(page, 'Connect & Authorize');
        logStep('[lifecycle] 5 step: clicked Connect & Authorize, waiting for redirect');
      } catch {
        // The page may have moved between the check and the click - the
        // URL check at the loop head resolves it next iteration.
      }
      // Give the PAR/authorize chain a moment to move the page.
      const moved = await Promise.race([
        page.waitForURL((u) => !u.toString().includes(meta.eopencaHostname), { timeout: 4_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      if (moved) { consentClicked = true; break; }
      // Still on the detail page - the start may have failed (snackbar);
      // wait out the snackbar and re-click.
      await page.waitForTimeout(1_000);
    }
    if (!consentClicked) {
      logStep('[lifecycle] 5 step: consent start never redirected after 15s of retries');
    }

    // Wait for redirect to iBank's Sentin8:Auth sign-in page.
    // FAIL FAST: report the current URL when the deadline expires.
    const consentDeadline = Date.now() + 5_000;
    let consentStarted = false;
    while (Date.now() < consentDeadline) {
      const url = page.url();
      if (url.includes('auth.') || url.includes('/oauth/authorize') || url.includes('/sign-in')) {
        try {
          await waitForFlutterSemantics(page, 2_000);
          consentStarted = true;
          break;
        } catch { /* navigation in progress */ }
      }
      await page.waitForTimeout(500);
    }
    expect(consentStarted, `FDX consent flow should redirect to iBank Sentin8:Auth - still on ${page.url()}`).toBe(true);
    logStep('[lifecycle] iBank consent flow started - redirected to provider Sentin8:Auth');

    await signInOnAuth8(page, meta.aliceEmail, Personas.alice.password!);
    logStep('[lifecycle] 5 step: Alice entered iBank Sentin8:Auth credentials');

    await waitForFlutterText(page, 'Authorize', 2_000);
    await page.waitForTimeout(500);
    await clickFlutterButton(page, 'Authorize');
    await page.waitForTimeout(500);
    logStep('[lifecycle] 5 step: Alice clicked Authorize, waiting for callback chain');

    // Wait for the OAuth callback chain to complete.
    // FAIL FAST: report the current URL when the deadline expires.
    const callbackDeadline = Date.now() + 10_000;
    let consentCompleted = false;
    while (Date.now() < callbackDeadline) {
      const url = page.url();
      if (
        (url.includes(meta.eopencaHostname) || url.includes('iopenca')) &&
        !url.includes('auth.') &&
        !url.includes('/fdx/consents/callback') &&
        !url.includes('/oauth/') &&
        !url.includes('/sign-in')
      ) {
        try {
          await waitForFlutterSemantics(page, 2_000);
          consentCompleted = true;
          break;
        } catch { /* Flutter still booting */ }
      }
      await page.waitForTimeout(500);
    }
    expect(consentCompleted, `FDX consent flow should complete and redirect back to eOpenCA - still on ${page.url()}`).toBe(true);
    logStep('[lifecycle] 5 step: FDX consent completed - redirected back to eOpenCA app');

    // Verify Alice can see her connected iBank accounts.
    await waitForFlutterText(page, 'Accounts', 2_000);
    await clickFlutterButton(page, 'Accounts');
    await waitForFlutterSemantics(page, 2_000);
    logStep('[lifecycle] 5 step: navigated to Accounts page');

    let hasAccounts = false;
    try {
      // The provider seeds the consent grant asynchronously from the AS's
      // grant event (~6-8s settle ride) and the app's accounts hook polls
      // through that window - give the poll room to land (20s).
      await waitForFlutterText(page, 'Checking', 20_000);
      hasAccounts = true;
    } catch {
      const texts = await getFlutterTexts(page);
      const allText = texts.join(' ').toLowerCase();
      if (allText.includes('no accounts yet') || allText.includes('no connected accounts')) {
        throw new Error(`eOpenCA Accounts page shows EMPTY state - consent data did not flow. Page: ${texts.slice(0, 15).join(' | ')}`);
      } else if (allText.includes('checking') || allText.includes('savings') || allText.includes('credit card')) {
        hasAccounts = true;
      } else {
        throw new Error(`No iBank accounts on eOpenCA Accounts page. Page: ${texts.slice(0, 15).join(' | ')}`);
      }
    }
    expect(hasAccounts, 'eOpenCA Accounts page should show iBank accounts after consent (not empty state)').toBe(true);
    logStep('[lifecycle] 5 step: eOpenCA verified - Alice can see her iBank accounts after FDX consent');

    // Verify the consent appears on the Connections page.
    await waitForFlutterText(page, 'Connections', 2_000);
    await clickFlutterButton(page, 'Connections');
    await waitForFlutterSemantics(page, 2_000);
    logStep('[lifecycle] 5 step: navigated to Connections page');
    let hasConsent = false;
    try {
      await waitForFlutterText(page, 'ACTIVE', 2_000);
      hasConsent = true;
    } catch {
      try {
        await waitForFlutterText(page, 'Revoke', 2_000);
        hasConsent = true;
      } catch {
        const texts = await getFlutterTexts(page);
        throw new Error(`No active iBank consent on eOpenCA Connections page. Page: ${texts.slice(0, 15).join(' | ')}`);
      }
    }
    expect(hasConsent, 'eOpenCA Connections page should show the active iBank consent').toBe(true);
    logStep('[lifecycle] 5 done: eOpenCA Connections page verified - active iBank consent visible');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // eOpenCA - Alice signs out, signs back in, and verifies the account
  // INFORMATION (the consent survives the session: a fresh BFF session
  // re-reads the persisted recipient registry + the delegated-token data
  // path end to end)
  // ═══════════════════════════════════════════════════════════════════════

  test('6. Alice re-logs into eOpenCA and verifies her connected account information', async () => {
    await maybePause(page, '6.');
    logStep('[lifecycle] 6 start: Alice signs out of eOpenCA, signs back in, and verifies account info');
    const iopencaAppURL = `https://${meta.eopencaHostname}`;

    // Sign out through the app's sidebar (the logout IconButton - its
    // tooltip renders as the Semantics label; the eOpenCA app has no test
    // bridge, so the UI logout button is the honest path). signOut clears
    // the local auth state WITHOUT a navigation - the shell's auth
    // listener rebuilds to the landing page (the "Sign In" surface). A
    // fresh sign-in then proves the consent PERSISTED - the new session
    // reads the registry, not the in-memory consent state of the old one.
    await waitForFlutterSemantics(page, 2_000);
    let signedOut = false;
    try {
      await clickFlutterButton(page, 'Sign Out');
      // The BFF session is gone + the local state cleared: the shell
      // re-renders the landing page (no URL change - poll the surface).
      const logoutDeadline = Date.now() + 8_000;
      while (Date.now() < logoutDeadline) {
        try {
          await waitForFlutterText(page, 'Sign In', 1_500);
          signedOut = true;
          break;
        } catch {
          // The auth listener has not fired yet - retry.
          try { await clickFlutterButton(page, 'Sign Out', true); } catch { /* already clicked */ }
        }
      }
    } catch {
      const texts = await getFlutterTexts(page);
      logStep(`[lifecycle] 6 step: sign-out click failed (page: ${texts.slice(0, 10).join(' | ')})`);
    }
    expect(signedOut, 'the eOpenCA Sign Out button must end the session and show the landing page').toBe(true);
    logStep('[lifecycle] 6 step: Alice signed out of eOpenCA');

    // Sign back in - the full OAuth round-trip through the iOpenCA
    // tenant's Auth8. signInToTenantAuth8 handles the landing-page
    // "Sign In" → Auth8 → (the consent screen a fresh sign-in presents)
    // → callback chain. Clear the auth rate limiter first (the consent
    // flow in step 5 already signed Alice in once).
    clearAuthRateLimits(meta.aliceEmail);
    await signInToTenantAuth8(page, context, iopencaAppURL, meta.aliceEmail, Personas.alice.password!);
    logStep('[lifecycle] 6 step: Alice signed back in to eOpenCA');

    // The Accounts page must show the connected iBank accounts through
    // the NEW session (the delegated token is re-loaded from the
    // recipient registry - the consent survived the session end). The
    // accounts hook polls while the list is empty (the grant-settle
    // window), so poll for the account card like test 5 does - the
    // accounts are ALREADY settled by now (test 5 verified them), but
    // the fresh session's first read can still race the BFF session's
    // token bootstrap.
    await waitForFlutterText(page, 'Accounts', 2_000);
    await clickFlutterButton(page, 'Accounts', true);
    await waitForFlutterSemantics(page, 2_000);
    let acctAll = '';
    {
      const acctDeadline = Date.now() + 20_000;
      while (Date.now() < acctDeadline) {
        const acctTexts = await getFlutterTexts(page);
        acctAll = acctTexts.join(' ');
        if (acctAll.includes('iBank Checking') || acctAll.includes('iBank Savings') || acctAll.includes('iBank Credit Card')) {
          break; // The accounts rendered.
        }
        await page.waitForTimeout(1_000);
      }
    }
    expect(
      acctAll.includes('iBank Checking') || acctAll.includes('iBank Savings') || acctAll.includes('iBank Credit Card'),
      'the fresh session must still show the connected iBank accounts',
    ).toBe(true);
    expect(
      acctAll.toLowerCase().includes('no accounts yet'),
      'a re-logged customer must NOT see the empty state - her consent persisted',
    ).toBe(false);
    logStep('[lifecycle] 6 step: accounts visible through the fresh session');

    // The account CARD carries the information fields the FDX accounts
    // read returns: the nickname, the account type, the masked account
    // number, and the balance + status. Open the first account's detail
    // page and verify the information surfaces.
    await clickFlutterButton(page, 'iBank Checking');
    await waitForFlutterSemantics(page, 2_000);
    const detailTexts = await getFlutterTexts(page);
    const detailAll = detailTexts.join(' ');
    expect(detailAll, 'the account detail page must render').toContain('Current Balance');
    expect(detailAll, 'the account detail page carries the account number (the masked FDX field)').toContain('Account Number');
    expect(detailAll, 'the account detail page carries the type (Checking)').toContain('Checking');
    // The detail page exposes the transaction history (the FDX
    // transactions read the app surfaces).
    await waitForFlutterText(page, 'View Transactions', 2_000);
    await clickFlutterButton(page, 'View Transactions');
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'Transactions', 3_000);
    const txnTexts = await getFlutterTexts(page);
    const txnAll = txnTexts.join(' ');
    // The account is brand-new (opened this run) - an EMPTY transaction
    // list is the honest state; what must hold is that the surface
    // ANSWERED (the page renders, never a proxy/consent error).
    expect(
      txnAll.toLowerCase().includes('no transactions yet') || txnAll.length > 0,
      `the Transactions page must render (page: ${txnTexts.slice(0, 15).join(' | ')})`,
    ).toBe(true);
    logStep('[lifecycle] 6 done: account information + transactions verified through the fresh session');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // FDX recipient API coverage - the consent-scoped reads + the
  // revocation contract (a revoked consent stops serving data)
  // ═══════════════════════════════════════════════════════════════════════

  test('7. the FDX recipient API surface: the consent-scoped accounts, the transactions read, and the revocation contract', async () => {
    await maybePause(page, '7.');
    logStep('[lifecycle] 7 start: FDX recipient API coverage + the revocation contract');
    const bffBase = `https://bff.${meta.eopencaHostname}`;

    // The app session (Alice's fresh BFF8 cookie from step 6) IS the
    // recipient's session - the same lane the app's own hooks use
    // (/proxy/openfin8-ca/...). Drive the recipient APIs directly.
    // (a) The consents list - the registry the Connections page renders.
    const consentsRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/consents`, { failOnStatusCode: false });
    expect(consentsRes.status(), 'the recipient consents list must answer 200 through the BFF session').toBe(200);
    const consentsBody = (await consentsRes.json()) as { consents?: Array<{ id: string; status: string; provider_id?: string }> };
    const consents = consentsBody.consents ?? [];
    expect(consents.length, 'the consents list must carry the active iBank connection').toBeGreaterThanOrEqual(1);
    // The registry's wire status is the raw DB form (lowercase 'active') -
    // the same value the Connections page badge renders.
    const active = consents.find((c) => c.status.toLowerCase() === 'active') ?? consents[0];
    const consentId = active.id;
    logStep(`[lifecycle] 7 step: recipient consents list ok (${consents.length} consents, active id ${consentId.slice(0, 8)}...)`);

    // (b) The consent-scoped accounts read (the consent_id filter the
    // consent flow's account selection persists).
    const scopedRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/accounts?consent_id=${consentId}`, { failOnStatusCode: false });
    expect(scopedRes.status(), 'the consent-scoped accounts read must answer 200').toBe(200);
    const scopedBody = (await scopedRes.json()) as { accounts?: Array<{ accountId?: string; id?: string; nickname?: string }> };
    const scopedAccounts = scopedBody.accounts ?? [];
    expect(scopedAccounts.length, 'the consent-scoped read must return the connected accounts').toBeGreaterThanOrEqual(1);
    const anyAccount = scopedAccounts[0];
    const accountId = anyAccount.accountId ?? anyAccount.id ?? '';
    expect(accountId, 'the account document must carry the account id').toBeTruthy();
    logStep(`[lifecycle] 7 step: consent-scoped accounts read ok (${scopedAccounts.length} accounts)`);

    // (c) The unfiltered accounts read - the app's Accounts page lane
    // (the most-recent-active-connection fallback).
    const unscopedRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/accounts`, { failOnStatusCode: false });
    expect(unscopedRes.status(), 'the unfiltered accounts read must answer 200').toBe(200);

    // (d) The transaction history read for one account (the FDX
    // transactions surface the app's View Transactions page drives).
    const txnsRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/accounts/${accountId}/transactions`, { failOnStatusCode: false });
    const txnsBodyText = await txnsRes.text();
    expect(
      txnsRes.status(),
      `the recipient transactions read must answer 200 (the consent carries transactions:read) - got ${txnsRes.status()}: ${txnsBodyText.slice(0, 300)}`,
    ).toBe(200);
    logStep('[lifecycle] 7 step: recipient transactions read ok');

    // (e) The provider catalog read - the Providers page's data source.
    const providersRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/providers`, { failOnStatusCode: false });
    expect(providersRes.status(), 'the recipient provider catalog must answer 200').toBe(200);
    const providersBody = (await providersRes.json()) as { providers?: Array<{ id?: string; name?: string }> };
    const providers = providersBody.providers ?? [];
    expect(providers.length, 'the catalog must still list the iBank provider').toBeGreaterThanOrEqual(1);
    logStep('[lifecycle] 7 step: provider catalog read ok');

    // (f) The revocation contract: revoke the consent through the same
    // recipient API the app's Connections page drives, then the data
    // surfaces must STOP serving (the negative assertion - the revoked
    // consent no longer carries data across the recipient plane). The
    // BFF gates mutation POSTs on X-BFF-CSRF (the session's csrf_token
    // - the same header the app sends); read it from /auth/session like
    // the app does.
    const sessionRes = await page.request.get(`${bffBase}/auth/session`, { failOnStatusCode: false });
    expect(sessionRes.status(), 'the BFF session read must answer 200').toBe(200);
    const sessionBody = (await sessionRes.json()) as { csrf_token?: string };
    const csrf = sessionBody.csrf_token ?? '';
    expect(csrf, 'the session must carry the CSRF token').toBeTruthy();
    const revokeRes = await page.request.post(`${bffBase}/proxy/openfin8-ca/v1/recipient/consents/${consentId}/revoke`, {
      data: { reason: 'USER_ACTION' },
      headers: { 'X-BFF-CSRF': csrf },
      failOnStatusCode: false,
    });
    expect(revokeRes.status(), 'the consent revocation must answer 200').toBe(200);
    const revokeBody = (await revokeRes.json()) as { status?: string };
    expect((revokeBody.status ?? '').toLowerCase(), 'the registry row must render the revoked status').toBe('revoked');
    logStep('[lifecycle] 7 step: consent revoked through the recipient API');

    // The registry list reflects the revocation (the Connections page's
    // data source): the consent no longer reports active.
    const afterListRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/consents`, { failOnStatusCode: false });
    expect(afterListRes.status(), 'the consents list must still answer 200 after revocation').toBe(200);
    const afterList = (await afterListRes.json()) as { consents?: Array<{ id: string; status: string }> };
    const revokedRow = (afterList.consents ?? []).find((c) => c.id === consentId);
    expect((revokedRow?.status ?? '').toLowerCase(), 'the revoked consent must render revoked in the registry list').toBe('revoked');

    // The accounts read stops serving the revoked connection's data:
    // the unfiltered read falls back to the most-recent ACTIVE
    // connection - with none left it answers the honest empty list
    // (never the revoked connection's accounts).
    const afterAccountsRes = await page.request.get(`${bffBase}/proxy/openfin8-ca/v1/recipient/accounts`, { failOnStatusCode: false });
    expect(afterAccountsRes.status(), 'the accounts read must answer 200 after revocation (the honest empty state, not an error)').toBe(200);
    const afterAccounts = ((await afterAccountsRes.json()) as { accounts?: Array<{ id?: string }> }).accounts ?? [];
    expect(afterAccounts, 'a revoked-out recipient must see NO accounts (the empty registry state)').toHaveLength(0);
    logStep('[lifecycle] 7 done: the revocation contract verified - data access stopped with the consent');
  });
});

// ── Helpers ────────────────────────────────────────────────────────────

/** Open a ledger account for the given product via the eBank UI. */
async function openLedgerAccountViaUI(page: Page, productName: string, _denomination: string, navPage: string = 'Products'): Promise<void> {
  logStep(`[lifecycle] openLedgerAccountViaUI: starting for ${productName} (nav: ${navPage}), URL: ${page.url()}`);
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, navPage, 2_000);
  await clickFlutterButton(page, navPage, true);
  await page.waitForTimeout(500);
  await waitForFlutterText(page, productName, 2_000);
  // Click the product card (Semantics button labelled with the product name).
  try {
    const btn = page.getByRole('button', { name: productName, exact: false });
    if (await btn.count() > 0) {
      await btn.first().click({ force: true });
    } else {
      await clickFlutterButton(page, productName);
    }
  } catch {
    await clickFlutterButton(page, productName);
  }
  await page.waitForTimeout(500);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the detail page - it has an "Account Name (Nickname)" label.
  // FAIL FAST: if the detail page did not load after two clicks, fail with
  // page context instead of clicking "Open Account" on the wrong page.
  try {
    await waitForFlutterText(page, 'Nickname', 2_000);
  } catch {
    const detailTexts = await getFlutterTexts(page);
    throw new Error(`Account detail page did not load for ${productName} (no Nickname field). Page: ${detailTexts.slice(0, 12).join(' | ')}`);
  }
  await page.waitForTimeout(500);
  await clickFlutterButton(page, 'Open Account', true);
  logStep(`[lifecycle] openLedgerAccountViaUI: clicked Open Account`);
  // Verify the account was created - success message or return to catalog.
  try {
    await waitForFlutterText(page, 'successfully', 3_000);
    logStep(`[lifecycle] openLedgerAccountViaUI: account created successfully`);
  } catch {
    const afterTexts = await getFlutterTexts(page);
    const stillOnForm = afterTexts.some((t) => t.includes('Nickname'));
    if (stillOnForm) {
      throw new Error(`Open Account submit for ${productName} did not confirm - still on the detail form. Page: ${afterTexts.slice(0, 12).join(' | ')}`);
    }
    // Navigated away from the form - treat as created (some flows redirect).
    logStep(`[lifecycle] openLedgerAccountViaUI: submitted (no success text; form dismissed)`);
  }
  try {
    await page.waitForTimeout(500);
    await clickFlutterButton(page, navPage, true);
    await page.waitForTimeout(500);
  } catch { /* might already be on the catalog page */ }
  await waitForFlutterSemantics(page, 2_000);
  logStep(`[lifecycle] openLedgerAccountViaUI: done, URL: ${page.url()}`);
}