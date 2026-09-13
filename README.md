<div align="center">

# 🛡️ Amy Wireless Care+

### Device Protection & Extended Warranty Studio

**A modern insurance operations workspace for wireless retail, repair, and device protection.**

[![Frontend](https://img.shields.io/badge/frontend-HTML%20%2B%20Tailwind-38bdf8?style=for-the-badge)](#)
[![Payments](https://img.shields.io/badge/payments-Stripe-635bff?style=for-the-badge)](#)
[![Email](https://img.shields.io/badge/email-Brevo-0b996e?style=for-the-badge)](#)
[![Edge](https://img.shields.io/badge/edge-Cloudflare%20Workers%20%2B%20D1-f38020?style=for-the-badge)](#)

</div>

---

## ✨ What is Care+?

**Amy Wireless Care+** brings the core workflows of a device-protection operation into one focused workspace — from point-of-sale quotation and policy issuance through claims, policy records, underwriting/rates, and financial analytics.

It is designed around the way a wireless retailer actually operates: **quote → protect → service → track → analyze**.

### The operating flow

**Issue Policy** → **Claims** → **Ledger** → **Rates** → **Financials**

---

## 🏗️ Architecture

```
┌───────────────────────────────┐
│       Amy Wireless POS        │
│   Quote • Coverage • Issue    │   (Cloudflare Pages — warranty.amywireless.ca)
└───────────────┬───────────────┘
                │ HTTPS (behind Cloudflare Access)
                ▼
┌───────────────────────────────┐
│     Cloudflare Worker API     │
│   Gateway • Validation • CRUD │   (pawan-insurance worker)
└───┬───────────┬───────────┬───┘
    │           │           │
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Stripe │ │ Brevo  │ │  D1    │
│ (pay)  │ │(email) │ │ (data) │
└────────┘ └────────┘ └────────┘
```

- **Frontend**: single-page `index.html` served from Cloudflare Pages (`warranty.amywireless.ca`).
- **Backend**: Cloudflare Worker (`pawan-insurance`) exposing a JSON API, authenticated by Cloudflare Access.
- **Data**: Cloudflare D1 (SQLite) — policies and claims persist across sessions and devices.
- **Payments**: Stripe (Payment Element, PaymentIntents, Payment Links).
- **Email**: Brevo transactional email (receipts, policy documents, payment links).

---

## 🔌 Worker API

All routes except `/health`, `/ping`, and `/webhook` require an authenticated operator
(Cloudflare Access injects `Cf-Access-Authenticated-User-Email`, which the Worker reads).

| Endpoint | Method | Purpose |
|---|---|---|
| `/health`, `/ping` | GET | Service + Stripe + D1 health check (public) |
| `/policies` | GET | List all policies |
| `/policies` | POST | Create or update a policy (upsert) |
| `/policies/:id` | DELETE | Delete a policy |
| `/create` | POST | Create a Stripe PaymentIntent (idempotent, amount-capped) |
| `/check?id=pi_...` | GET | Check PaymentIntent status |
| `/cancel` | POST | Cancel a PaymentIntent |
| `/email` | POST | Send an email (Brevo, cc warranty@amywireless.ca) |
| `/payment-link` | POST | Create a Stripe Payment Link |
| `/webhook` | POST | Stripe webhook (signature-verified; marks policies paid) |

### Auth model

- Operator endpoints require the `Cf-Access-Authenticated-User-Email` header, which Cloudflare
  Access sets at the edge. Cloudflare strips any client-supplied `Cf-*` headers, so this value
  cannot be spoofed.
- `/webhook` is public but verifies the `Stripe-Signature` header using `STRIPE_WEBHOOK_SECRET`.

### Secrets (Worker bindings)

| Binding | Type | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | Stripe gateway |
| `BREVO_API_KEY` | secret | Brevo email |
| `BREVO_SENDER_EMAIL` | (optional) | Default `warranty@amywireless.ca` |
| `BREVO_SENDER_NAME` | (optional) | Default `Amy Wireless Care+` |
| `BREVO_CC_EMAIL` | (optional) | Default `warranty@amywireless.ca` |
| `STRIPE_WEBHOOK_SECRET` | secret | Stripe webhook signature (set after creating the webhook endpoint) |
| `MAX_AMOUNT_CAD` | (optional) | Hard ceiling per charge (default 50000) |
| `DB` | D1 binding | `pawan-insurance-db` |

---

## 🖥️ Running the Frontend

Production: `https://warranty.amywireless.ca` (deploys automatically from the `main` branch of this repo).

The frontend is a static `index.html` — no build step required. To run locally, open the file in a
browser and configure the Worker URL + Stripe publishable key in the "Cloudflare & Stripe Gateway
Config" modal (top-right gear). The Worker URL and publishable key are stored in the browser's
`localStorage`; secret keys never leave the Worker.

---

## 🧪 Testing the payment flow

1. Open `warranty.amywireless.ca` and sign in via Cloudflare Access.
2. Issue a policy → the Stripe Payment Element collects card details (card data never touches your server — PCI SAQ-A).
3. Alternatively, "Send Payment Link" emails the customer a hosted Stripe checkout URL; the policy is recorded as `pending` until the webhook marks it `paid`.

---

## 🔐 Security notes

- Never commit Stripe secret keys or other credentials.
- Keep payment/email secrets in the Worker bindings, not the browser.
- The Worker rejects requests without a valid Cloudflare Access identity.
- Payment amounts are capped server-side (`MAX_AMOUNT_CAD`).
- Stripe PaymentIntent creation is idempotent (per-policy key) to prevent duplicate charges on retry.
- Customer-facing HTML output is escaped to prevent stored XSS.
- Use HTTPS for all production traffic.

---

## 🧭 Remaining hardening (not yet done)

- [ ] Stripe webhook is implemented but dormant: create the endpoint in Stripe
      (→ `https://warranty.amywireless.ca/webhook`), set `STRIPE_WEBHOOK_SECRET`, and add a
      Cloudflare Access "bypass" policy for the `/webhook` path so Stripe can reach it.
- [ ] Server-side premium recomputation (the Worker currently caps amounts but trusts the
      client-computed premium; porting the rating engine server-side is the next step).
- [ ] Monthly billing: "Monthly" charges month 1 only; recurring billing (Stripe Subscriptions)
      is not yet implemented.
- [ ] Automated tests for the rating/actuarial logic.
- [ ] Module split + lint + a production Tailwind build (the app currently uses the Tailwind Play CDN).

---

## 📄 License

No license is currently declared in the repository. Add an explicit `LICENSE` file before distributing the project publicly.

