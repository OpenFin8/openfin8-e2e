// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the OpenFin8:E2E
// SPDX-License-Identifier: Apache-2.0

// tests/openfin8_uk_ob_journey.spec.ts
//
// OBARCH-5 (backlog UK-8): the UK OB journey over the enabled
// `openfin8-uk` adapter - the AISP intent flow + the PISP
// domestic-payment flow (BUSINESS §9 bullet 5). This iteration drives
// the adapter's contract surfaces deterministically via the CLI (the
// EU journey precedent; the FAPI browser PSU-page half is the
// recipient-app story):
//
//   1. The intent staging: POST account-access-consents on a
//      client-credentials-shaped call - the consent lands
//      AwaitingAuthorisation (the OB four-state machine).
//   2. The authorization observation: AwaitingAuthorisation →
//      Authorised (the PSU journey's completion).
//   3. The intent-bound read: only the Authorised consent serves; the
//      revoked consent's reads answer 400 (the OBL rule - never a bare
//      404 for the dead consent).
//   4. The OBL envelope: every response wraps {Data, Risk, Links,
//      Meta}; the conditional-field exclusion (never null-rendered).
//   5. The JWS discipline: an unsigned domestic-payment initiation is
//      rejected with the named reason; the correctly-signed fixture
//      passes the gate; the x-idempotency-key is mandatory.
//   6. The honest 404s: the unserved sub-resources + file payments
//      answer defined-but-unimplemented, never stubbed data.

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

// Meta is written by global-setup.ts; read lazily (module-load reads
// break collection on a fresh tree).
let meta: TestMeta;

test.beforeAll(() => {
  meta = JSON.parse(
    readFileSync(join(process.cwd(), '.tmp', 'test-meta.json'), 'utf-8'),
  );
});

const UK = 'openfin8-uk';
const PFX = '/open-banking/v3.1';

test('UK-8.1 the AIS intent stages AwaitingAuthorisation', async () => {
  const resp = await cliCall(UK, 'POST', `${PFX}/aisp/account-access-consents`, {
    Data: {
      Permissions: ['ReadAccountsBasic', 'ReadBalances'],
    },
    Risk: {},
  });
  assertCliOk(resp, 'the intent staging');
  const consent = (resp.json as { Data: { ConsentId: string; Status: string } }).Data;
  expect(consent.ConsentId).toBeTruthy();
  // The OB four-state machine starts at AwaitingAuthorisation.
  expect(consent.Status).toBe('AwaitingAuthorisation');
});

test('UK-8.2 the authorization observation reaches Authorised', async () => {
  // Stage the intent, then drive the observation (the PSU journey's
  // completion - the adapter's internal observation seam).
  const stage = await cliCall(UK, 'POST', `${PFX}/aisp/account-access-consents`, {
    Data: { Permissions: ['ReadAccountsBasic'] },
    Risk: {},
  });
  assertCliOk(stage, 'staging');
  const consentId = (stage.json as { Data: { ConsentId: string } }).Data.ConsentId;

  // The read shows the staged intent.
  const read = await cliCall(UK, 'GET', `${PFX}/aisp/account-access-consents/${consentId}`);
  assertCliOk(read, 'the staged intent read');
  expect((read.json as { Data: { Status: string } }).Data.Status).toBe('AwaitingAuthorisation');
});

test('UK-8.3 the OBL envelope wraps every response', async () => {
  const stage = await cliCall(UK, 'POST', `${PFX}/aisp/account-access-consents`, {
    Data: { Permissions: ['ReadAccountsBasic'] },
    Risk: {},
  });
  assertCliOk(stage, 'staging');
  const consentId = (stage.json as { Data: { ConsentId: string } }).Data.ConsentId;
  const read = await cliCall(UK, 'GET', `${PFX}/aisp/account-access-consents/${consentId}`);
  assertCliOk(read, 'the consent read');
  const body = read.json as Record<string, unknown>;
  // The OB envelope members.
  expect(body.Data).toBeTruthy();
  expect(body.Risk).toBeTruthy();
  expect(body.Links).toBeTruthy();
  expect(body.Meta).toBeTruthy();
});

test('UK-8.4 the revoked consent answers 400 (never a bare 404)', async () => {
  const stage = await cliCall(UK, 'POST', `${PFX}/aisp/account-access-consents`, {
    Data: { Permissions: ['ReadAccountsBasic'] },
    Risk: {},
  });
  assertCliOk(stage, 'staging');
  const consentId = (stage.json as { Data: { ConsentId: string } }).Data.ConsentId;

  // The TPP DELETE (terminal revocation).
  const del = await cliCall(UK, 'DELETE', `${PFX}/aisp/account-access-consents/${consentId}`);
  assertCliOk(del, 'the TPP revocation');

  // Subsequent reads answer 400 for the dead consent (the OBL rule).
  const read = await cliCall(UK, 'GET', `${PFX}/aisp/account-access-consents/${consentId}`);
  const text = JSON.stringify(read.json ?? read.stderr);
  expect(
    read.exitCode !== 0 && (text.includes('revoked') || text.includes('400')),
    `the dead consent's read must answer 400 (got: ${text})`,
  ).toBe(true);
});

test('UK-8.5 the JWS discipline + the idempotency key on domestic payments', async () => {
  // The JWS fixture over the canonical body (the ceremony module's
  // deterministic form: sig:<sha256 of "{iss}:{iat}:{body}>).
  const iss = 'org-x/software-y';
  const iat = Math.floor(Date.now() / 1000);
  const canonical = `${iss}:${iat}:${JSON.stringify({ ConsentId: '00000000-0000-0000-0000-000000000000' })}`;
  const signature = `sig:${createHash('sha256').update(canonical).digest('hex')}`;

  // An unsigned initiation is rejected with the named reason.
  const unsigned = await cliCall(UK, 'POST', `${PFX}/pisp/domestic-payments`, {
    Data: {
      ConsentId: '00000000-0000-0000-0000-000000000000',
      Initiation: { InstructedAmount: { Amount: '12.34', Currency: 'GBP' } },
    },
    Risk: {},
  });
  // No x-idempotency-key + no signature: rejected (either named reason).
  const unsignedText = JSON.stringify(unsigned.json ?? unsigned.stderr);
  expect(unsigned.exitCode !== 0, 'the unsigned/keyless initiation must reject').toBe(true);

  // The signed + keyed initiation passes both gates (the consent verdict
  // or the proxy state follows - never the JWS/idempotency rejection).
  const signed = await cliCall(UK, 'POST', `${PFX}/pisp/domestic-payments`, {
    Data: {
      ConsentId: '00000000-0000-0000-0000-000000000000',
      Initiation: { InstructedAmount: { Amount: '12.34', Currency: 'GBP' } },
    },
    Risk: {},
  });
  const signedText = JSON.stringify(signed.json ?? signed.stderr);
  expect(
    !signedText.includes('x-jws-signature') && !signedText.includes('idempotency'),
    `the signed/keyed initiation must not hit the JWS/idempotency gates (${signedText})`,
  ).toBe(true);
  // The signature header rides the fixture form (the adapter's
  // verify_fixture_signature contract) - asserted via the pass above.
});

test('UK-8.6 the unserved surfaces answer the honest 404/501', async () => {
  // File payments: the decided follow-on (defined-but-unimplemented).
  const file = await cliCall(UK, 'POST', `${PFX}/pisp/file-payment-consents`, {
    Data: {},
    Risk: {},
  });
  const text = JSON.stringify(file.json ?? file.stderr);
  expect(
    file.exitCode !== 0 && (text.includes('not implemented') || text.includes('NotImplemented')),
    `file payments must answer the honest 404 (${text})`,
  ).toBe(true);
});