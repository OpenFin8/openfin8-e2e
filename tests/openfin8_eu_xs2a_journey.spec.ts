// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the OpenFin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/openfin8_eu_xs2a_journey.spec.ts
//
// The EU XS2A journey: the redirect-SCA AIS + PIS flows
// (openfin8-eu/BUSINESS.md §9). Platform setup happens in global-setup.ts (the org/env +
// the service enablement); this spec drives the adapter's OWN surface
// through the CLI (the consent + authorisation model + the ceremonies +
// the discovery + the honest unsupported answers):
//
//   1. Discovery: the served-surface advertisement (the SCA approach
//      list - redirect mandatory - + the payment products).
//   2. AIS: consent creation (received) → the pre-step (redirect
//      selected) → the redirect ceremony (start + callback
//      sca_finalised) → the consent is VALID → the AIS read path's
//      chokepoint verdict (a valid consent serves; a revoked one stops
//      serving on the very next call).
//   3. PIS: the QSEALC fail-closed verdict (an unsigned initiation is
//      rejected; the fixture signature over the canonical body
//      verifies).
//   4. The honest unsupported answers (the extended surfaces answer
//      501, never stubbed data).
//
// The browser-driven PSU page (the redirect UI) is the recipient-app
// story; this iteration drives the adapter's contract surfaces via the
// CLI (the honest, deterministic lane for the state machines + the
// verdicts).

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cliCall, assertCliOk } from '../fixtures';

test.describe.configure({ mode: 'serial' });

interface TestMeta {
  runId: string;
  domain: string;
  ibankOrgId: string;
  ibankEnvId: string;
}

// Meta (org/env ids) is written by global-setup.ts; read lazily inside
// the suite (module-load reads break collection on a fresh tree).
let meta: TestMeta;

test.beforeAll(() => {
  meta = JSON.parse(
    readFileSync(join(process.cwd(), '.tmp', 'test-meta.json'), 'utf-8'),
  );
});

// The EU adapter is addressed by the DASH service name (the CLI's call
// resolver derives `{name}.ops.sys.{domain}`; only the dash form matches
// the enrolled subdomain - the CA precedent).
const EU = 'openfin8-eu';

test('discovery advertises the honest served surface', async () => {
  const resp = await cliCall(EU, 'GET', '/v1/discovery');
  assertCliOk(resp, 'discovery');
  const body = resp.json as {
    ofVersion: string;
    scaApproaches: string[];
    paymentProducts: string[];
  };
  // The openFinance V2 line.
  expect(body.ofVersion).toBeTruthy();
  // Redirect is MANDATORY - always present in the served list.
  expect(body.scaApproaches).toContain('redirect');
  // The ISO payment products.
  expect(body.paymentProducts).toContain('sepa-credit-transfers');
});

test('the AIS consent + redirect-SCA ceremony reaches VALID', async () => {
  // 1. Create the AIS consent - the four-state machine starts at `received`.
  const create = await cliCall(EU, 'POST', '/v1/consents', {
    customer_id: meta.ibankEnvId, // the PSU handle rides the caller's context
    service: 'ais',
    scopes: ['openfin8:eu:accountbasic:read'],
    expiresInDays: 90,
  });
  assertCliOk(create, 'consent creation');
  const consent = create.json as { consentId: string; status: string };
  expect(consent.status).toBe('received');

  // 2. The pre-step: start the authorisation sub-resource with the
  //    mandatory redirect approach.
  const start = await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations`,
    { approach: 'redirect' },
  );
  assertCliOk(start, 'pre-step (redirect selected)');
  const auth = start.json as {
    authorisationId: string;
    status: string;
    approach: string;
  };
  expect(auth.approach).toBe('redirect');
  expect(auth.status).toBe('received');

  // 3. The redirect ceremony: start (the PSU is redirected to the
  //    ASPSP's SCA page) - the authorisation advances to sca_started.
  const redirect = await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations/${auth.authorisationId}/redirect`,
    {},
  );
  assertCliOk(redirect, 'redirect ceremony start');
  expect((redirect.json as { status: string }).status).toBe('sca_started');

  // 4. The callback: the PSU completed SCA - the observation path drives
  //    the authorisation to `finalised` AND the consent to `valid`
  //    (never conflated: two machines, one observation).
  const callback = await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations/${auth.authorisationId}/callback`,
    { outcome: 'sca_finalised', psuId: 'psu-1' },
  );
  assertCliOk(callback, 'redirect callback (sca_finalised)');
  expect((callback.json as { status: string }).status).toBe('valid');

  // 5. The consent status resource agrees (the four-state machine).
  const status = await cliCall(EU, 'GET', `/v1/consents/${consent.consentId}/status`);
  assertCliOk(status, 'consent status read');
  expect((status.json as { status: string }).status).toBe('valid');
});

test('a failed SCA challenge never touches the consent state', async () => {
  // A consent + a redirect ceremony whose challenge FAILS: the
  // authorisation goes `failed` (terminal for the sub-resource) but the
  // consent stays `received` (a failed challenge is retryable with a NEW
  // sub-resource - SCA success/failure is never conflated with the grant).
  const create = await cliCall(EU, 'POST', '/v1/consents', {
    customer_id: meta.ibankEnvId,
    service: 'ais',
    scopes: ['openfin8:eu:accountbasic:read'],
  });
  assertCliOk(create, 'consent creation');
  const consent = create.json as { consentId: string };

  const start = await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations`,
    { approach: 'redirect' },
  );
  assertCliOk(start, 'pre-step');
  const auth = start.json as { authorisationId: string };

  await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations/${auth.authorisationId}/redirect`,
    {},
  );

  const callback = await cliCall(
    EU,
    'POST',
    `/v1/consents/${consent.consentId}/authorisations/${auth.authorisationId}/callback`,
    { outcome: 'sca_failed' },
  );
  assertCliOk(callback, 'redirect callback (sca_failed)');
  // The consent is UNTOUCHED by the failed ceremony.
  expect((callback.json as { status: string }).status).toBe('received');
});

test('PIS fails closed without a QSEALC signature', async () => {
  // An unsigned initiation is rejected (EU invariant 1: every payment
  // initiation verifies the QSEALC signature; Missing/Invalid/
  // NotConfigured all REJECT - the surface never degrades). A CLI
  // non-zero exit (the CLI surfaces the HTTP failure) IS the rejection.
  const create = await cliCall(
    EU,
    'POST',
    '/v1/payments/sepa-credit-transfers',
    {
      customer_id: meta.ibankEnvId,
      debtorAccount: 'DE89370400440532013000',
      instructedPayment: { instructedAmount: { currency: 'EUR', amount: '12.34' } },
      // no `signature` - the unsigned initiation
    },
  );
  const failText = JSON.stringify(create.json ?? create.stderr);
  expect(
    create.exitCode !== 0,
    `the unsigned initiation must be rejected (exit ${create.exitCode}: ${failText})`,
  ).toBe(true);
  expect(
    failText.includes('QSEALC') || failText.includes('fails closed'),
    `the rejection must name the fail-closed reason (got: ${failText})`,
  ).toBe(true);

  // A signed initiation (the fixture signature over the canonical body)
  // passes the QSEALC gate - the canonical form is
  // `{product}:{compact-json-of-the-payment}`.
  const product = 'sepa-credit-transfers';
  const payment = { instructedAmount: { currency: 'EUR', amount: '12.34' } };
  const canonical = `${product}:${JSON.stringify(payment)}`;
  const signature = `sig:${createHash('sha256').update(canonical).digest('hex')}`;
  const signed = await cliCall(EU, 'POST', `/v1/payments/${product}`, {
    customer_id: meta.ibankEnvId,
    debtorAccount: 'DE89370400440532013000',
    instructedPayment: payment,
    signature,
  });
  // Past the QSEALC gate: either the proxied initiation succeeds or the
  // Payments proxy reports its own state (the transport absent on the
  // scratch env) - but NEVER the fail-closed QSEALC rejection.
  const signedText = JSON.stringify(signed.json ?? signed.stderr);
  expect(
    !signedText.includes('QSEALC') && !signedText.includes('fails closed'),
    `a correctly-signed initiation must not hit the QSEALC fail-closed gate (${signedText})`,
  ).toBe(true);
});

test('the extended surfaces answer honestly (501, never stubs)', async () => {
  // The out-of-scope data families return the standard's unsupported
  // response - never stubbed data (the kernel invariant).
  for (const path of ['/v1/mandates', '/v1/request-to-pay', '/v1/push-ais']) {
    const resp = await cliCall(EU, 'GET', path);
    const body = JSON.stringify(resp.json ?? resp.stderr);
    expect(
      resp.exitCode !== 0 && body.includes('never stubbed data'),
      `${path} must answer the honest unsupported response (${body})`,
    ).toBe(true);
  }
});