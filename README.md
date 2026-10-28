# OpenFin8 - E2E Test Suite

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-openfin8.dev-0E7C66)](https://openfin8.dev/)

The OpenFin8 vertical's end-to-end tests: the **recipient journey** -
the open-finance equivalent of the retired bank8 FDX e2e flow.

## The journey

Two institutions, one consent ceremony:

1. **Provider-side prerequisites** (bank8 org - the "iBank" tenant):
   platform inits run entirely through the `sentin8-cli`; Bank8:Admin
   creates the ledger products; Alice (the provider bank's customer)
   signs up via eBank and opens accounts.
2. **The recipient journey** (openfin8 org - the "iOpenCA" tenant):
   the eOpenCA app discovers iBank as a connectable provider; Alice
   authorizes the consent at the provider's hosted consent screen; the
   connection activates; the consented accounts + transactions flow
   back through the recipient APIs.

Invariants proven: consent enforcement (no grant, no data), the
two-ledger reconciliation (recipient registry ↔ provider grant ledger),
revocation on the next call, and tenant isolation between the two
institutions.

## Suite scope (the OBVERT-3 rule)

- **Platform + vertical inits**: all via the `sentin8-cli` (orgs,
  envs, service enables, app installs) - no Dash browser flows.
- **bank8 apps are used only as prerequisites** (eBank for Alice's
  accounts, Admin for product creation) - the bank8 app *flows*
  (eTeller CIBA, staff admin journeys) live in `bank8-e2e`.
- **The recipient journey is this suite's subject** - everything else
  is setup.

## Usage

```bash
make infra-up        # the platform fleet (see the platform docs)
npm install
npm test             # the recipient journey
```

The suite is TypeScript on official Playwright against the Flutter
apps (semantics-driven - no flaky pixel selectors).

---

**Architecture & Design:** openfin8:e2e and its underlying concepts
were designed by [Hamid Jahanzad](https://www.linkedin.com/in/hamidjahanzad/).
