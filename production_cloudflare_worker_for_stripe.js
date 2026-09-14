/**
 * Amy Wireless Care+ — Production Cloudflare Worker (v3)
 *
 * Persistent policy store (D1) + Stripe gateway + Brevo email + webhooks.
 *
 * Auth model:
 *   - /health, /ping  -> public (uptime monitoring)
 *   - /webhook        -> Stripe-Signature verified (public, used by Stripe)
 *   - everything else -> requires an authenticated operator via Cloudflare
 *                        Access (reads the Cf-Access-Authenticated-User-Email
 *                        header that Access injects at the edge).
 */

const DEFAULT_MAX_AMOUNT_CAD = 50000; // hard ceiling on any single charge

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed =
    origin.endsWith("amywireless.ca") ||
    origin.endsWith("pages.dev") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://warranty.amywireless.ca",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function getOperatorEmail(request) {
  // Set by Cloudflare Access at the edge; cannot be spoofed by the client
  // because Cloudflare strips any client-supplied Cf-* headers.
  return request.headers.get("Cf-Access-Authenticated-User-Email") || null;
}

async function listPolicies(env) {
  const res = await env.DB.prepare(
    "SELECT id, customer_name, customer_email, payment_status, payment_intent_id, payment_link_url, data, created_at, created_by FROM policies ORDER BY created_at DESC"
  ).all();
  return (res.results || []).map((r) => {
    const p = JSON.parse(r.data || "{}");
    return {
      ...p,
      paymentStatus: r.payment_status || p.paymentStatus || "pending",
      paymentIntentId: r.payment_intent_id || p.paymentIntentId || null,
      paymentLinkUrl: r.payment_link_url || p.paymentLinkUrl || null,
      createdBy: r.created_by || null,
    };
  });
}

async function upsertPolicy(env, p, operator) {
  await env.DB.prepare(
    `INSERT INTO policies (id, customer_name, customer_email, payment_status, payment_intent_id, payment_link_url, data, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       customer_name = excluded.customer_name,
       customer_email = excluded.customer_email,
       payment_status = excluded.payment_status,
       payment_intent_id = excluded.payment_intent_id,
       payment_link_url = excluded.payment_link_url,
       data = excluded.data`
  ).bind(
    p.id,
    p.customerName || null,
    p.customerEmail || null,
    p.paymentStatus || "pending",
    p.paymentIntentId || null,
    p.paymentLinkUrl || null,
    JSON.stringify(p),
    new Date().toISOString(),
    operator
  ).run();
}

async function recordStripePayment(env, policyId, payment) {
  const row = await env.DB.prepare(
    "SELECT data, payment_status FROM policies WHERE id = ?"
  ).bind(policyId).first();

  if (!row) return 0;

  let p = {};
  try { p = JSON.parse(row.data || "{}"); } catch { p = {}; }

  if (!Array.isArray(p.payments)) p.payments = [];
  p.payments.push({
    date: new Date().toISOString().split("T")[0],
    amount: payment.amount || 0,
    status: "paid",
    source: "stripe",
    txnId: payment.txnId || null
  });
  p.paymentStatus = "paid";

  await env.DB.prepare(
    "UPDATE policies SET payment_status = 'paid', payment_intent_id = COALESCE(payment_intent_id, ?), data = ? WHERE id = ?"
  ).bind(payment.txnId || null, JSON.stringify(p), policyId).run();

  return 1;
}

async function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  let timestamp = null;
  let sig = null;
  for (const part of signature.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = v;
    if (k === "v1") sig = v;
  }
  if (!timestamp || !sig) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // constant-time compare
  let diff = 0;
  const a = expected;
  const b = sig;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function sendEmail(env, to, subject, html) {
  const senderEmail = env.BREVO_SENDER_EMAIL || "warranty@amywireless.ca";
  const senderName = env.BREVO_SENDER_NAME || "Amy Wireless Care+";
  const ccEmail = env.BREVO_CC_EMAIL || "warranty@amywireless.ca";
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": env.BREVO_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      cc: [{ email: ccEmail }],
      subject,
      htmlContent: html,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, messageId: data.messageId || null, error: data.message || null };
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    let path = url.pathname.replace(/\/$/, "");
    if (path.startsWith("/api")) path = path.slice(4);

    // ---- Public health check ----
    if (path === "/health" || path === "/ping") {
      if (!env.STRIPE_SECRET_KEY) {
        return json({ status: "error", error: "STRIPE_SECRET_KEY is missing." }, 500, cors);
      }
      try {
        const testStripe = await fetch("https://api.stripe.com/v1/balance", {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        if (!testStripe.ok) {
          return json({ status: "error", error: "Stripe rejected secret key", stripe_status: testStripe.status }, 502, cors);
        }
        const isLive = env.STRIPE_SECRET_KEY.startsWith("sk_live_");
        let dbStatus = "error";
        try {
          await env.DB.prepare("SELECT 1 AS ok").run();
          dbStatus = "connected";
        } catch (e) {
          dbStatus = "error: " + e.message;
        }
        return json({
          status: "ok",
          worker: "amy-stripe-api",
          stripe_mode: isLive ? "LIVE PRODUCTION" : "TEST MODE",
          db: dbStatus,
          timestamp: new Date().toISOString(),
        }, 200, cors);
      } catch (err) {
        return json({ status: "error", error: err.message }, 500, cors);
      }
    }

    // ---- Stripe webhook (public, signature-verified) ----
    if (path === "/webhook" && request.method === "POST") {
      if (!env.STRIPE_WEBHOOK_SECRET) {
        return json({ error: "STRIPE_WEBHOOK_SECRET is not configured on this Worker." }, 501, cors);
      }
      const rawBody = await request.text();
      const signature = request.headers.get("Stripe-Signature");
      if (!(await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET))) {
        return json({ error: "Invalid Stripe-Signature" }, 400, cors);
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch {
        return json({ error: "Malformed webhook payload" }, 400, cors);
      }

      const obj = event.data?.object || {};
      const policyId = obj.metadata?.policy_id || obj.metadata?.policyId || null;

      if (event.type === "checkout.session.completed" || event.type === "payment_intent.succeeded") {
        if (!policyId) {
          return json({ received: true, note: "no policy_id in metadata — event skipped" }, 200, cors);
        }
        const amount = obj.amount_received
          ? obj.amount_received / 100
          : obj.amount_total / 100 || 0;
        const txnId = obj.payment_intent || obj.id || null;
        await recordStripePayment(env, policyId, { amount, txnId });
        return json({ received: true, policyId, status: "paid" }, 200, cors);
      }

      // Acknowledge other events so Stripe doesn't retry
      return json({ received: true }, 200, cors);
    }

    // ---- Everything below requires an authenticated operator ----
    const operator = getOperatorEmail(request);
    if (!operator) {
      return json({ error: "Unauthorized. Requests must pass through Cloudflare Access." }, 401, cors);
    }

    // ---- List policies ----
    if (path === "/policies" && request.method === "GET") {
      const policies = await listPolicies(env);
      return json({ policies }, 200, cors);
    }

    // ---- Upsert a policy ----
    if (path === "/policies" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed JSON" }, 400, cors);
      }
      if (!body || !body.id) {
        return json({ error: "Policy requires an 'id' field." }, 400, cors);
      }
      await upsertPolicy(env, body, operator);
      return json({ status: "saved", id: body.id }, 200, cors);
    }

    // ---- Delete a policy (soft: requires operator) ----
    if (path.startsWith("/policies/") && request.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/policies/".length));
      await env.DB.prepare("DELETE FROM policies WHERE id = ?").bind(id).run();
      return json({ status: "deleted", id }, 200, cors);
    }

    // ---- Check a PaymentIntent status ----
    if (path === "/check") {
      const intentId = url.searchParams.get("id");
      if (!intentId) return json({ error: "Missing query parameter 'id'" }, 400, cors);
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        const data = await stripeRes.json();
        if (!stripeRes.ok) {
          return json({ error: data.error?.message || "Stripe lookup failed" }, stripeRes.status, cors);
        }
        return json({
          paymentIntentId: data.id,
          status: data.status,
          amount_received: data.amount_received,
          currency: data.currency,
        }, 200, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    // ---- Create a PaymentIntent (idempotent, amount-capped) ----
    if (request.method === "POST" && (path === "/create" || path === "")) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed JSON" }, 400, cors);
      }
      const amount = parseFloat(body.amount);
      const description = body.description || "Amy Wireless Care+ Policy";
      const currency = (body.currency || "cad").toLowerCase();

      if (isNaN(amount) || amount < 0.50) {
        return json({ error: "Amount must be at least $0.50 CAD" }, 400, cors);
      }
      const maxAmount = parseFloat(env.MAX_AMOUNT_CAD || DEFAULT_MAX_AMOUNT_CAD);
      if (amount > maxAmount) {
        return json({ error: `Amount exceeds the ${maxAmount} CAD limit` }, 400, cors);
      }
      // Reject amounts with more than 2 decimal places
      if (Math.round(amount * 100) / 100 !== amount) {
        return json({ error: "Amount must have at most 2 decimal places" }, 400, cors);
      }

      const amountInCents = Math.round(amount * 100);
      const params = new URLSearchParams({
        amount: amountInCents.toString(),
        currency,
        description,
      });
      params.append("automatic_payment_methods[enabled]", "true");
      if (body.policy_id) {
        params.append("metadata[policy_id]", String(body.policy_id));
      }

      const headers = {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      };
      // Idempotency: a unique key per policy prevents duplicate intents on retry
      const idemKey = body.idempotency_key || (body.policy_id ? `policy-${body.policy_id}` : null);
      if (idemKey) headers["Idempotency-Key"] = idemKey;

      try {
        const stripeResponse = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers,
          body: params,
        });
        const stripeData = await stripeResponse.json();
        if (!stripeResponse.ok) {
          return json({ error: stripeData.error?.message || "Stripe API rejected creation" }, stripeResponse.status, cors);
        }
        return json({
          paymentIntentId: stripeData.id,
          clientSecret: stripeData.client_secret,
          status: stripeData.status,
        }, 200, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    // ---- Cancel a PaymentIntent ----
    if (path === "/cancel" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed JSON" }, 400, cors);
      }
      const intentId = body.payment_intent_id;
      if (!intentId || !intentId.startsWith("pi_")) {
        return json({ error: "Missing or invalid payment_intent_id" }, 400, cors);
      }
      try {
        const cancelRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        });
        const cancelData = await cancelRes.json();
        if (!cancelRes.ok) {
          return json({ error: cancelData.error?.message || "Stripe cancel failed" }, cancelRes.status, cors);
        }
        return json({ paymentIntentId: cancelData.id, status: cancelData.status }, 200, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    // ---- Send email ----
    if (path === "/email" && request.method === "POST") {
      if (!env.BREVO_API_KEY) {
        return json({ error: "BREVO_API_KEY is not configured on this Worker." }, 500, cors);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed JSON" }, 400, cors);
      }
      const to = body.to;
      const subject = body.subject || "Amy Wireless Care+";
      const html = body.html;
      if (!to || !html) {
        return json({ error: "Missing 'to' or 'html' in request body" }, 400, cors);
      }
      // Basic sanity: single recipient, must look like an email
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return json({ error: "Invalid recipient email" }, 400, cors);
      }
      const result = await sendEmail(env, to, subject, html);
      if (!result.ok) {
        return json({ error: result.error || `Brevo rejected (HTTP ${result.status})` }, result.status, cors);
      }
      return json({ status: "sent", messageId: result.messageId, to }, 200, cors);
    }

    // ---- Create a Stripe Payment Link ----
    if (path === "/payment-link" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Malformed JSON" }, 400, cors);
      }
      const amount = parseFloat(body.amount);
      const description = body.description || "Amy Wireless Care+ Policy";
      if (isNaN(amount) || amount < 0.50) {
        return json({ error: "Amount must be at least $0.50 CAD" }, 400, cors);
      }
      const maxAmount = parseFloat(env.MAX_AMOUNT_CAD || DEFAULT_MAX_AMOUNT_CAD);
      if (amount > maxAmount) {
        return json({ error: `Amount exceeds the ${maxAmount} CAD limit` }, 400, cors);
      }

      const amountInCents = Math.round(amount * 100);
      const params = new URLSearchParams({
        "line_items[0][price_data][currency]": "cad",
        "line_items[0][price_data][unit_amount]": amountInCents.toString(),
        "line_items[0][price_data][product_data][name]": description,
        "line_items[0][quantity]": "1",
      });
      if (body.metadata) {
        Object.entries(body.metadata).forEach(([k, v]) => params.append(`metadata[${k}]`, String(v)));
      }

      try {
        const stripeRes = await fetch("https://api.stripe.com/v1/payment_links", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
        });
        const stripeData = await stripeRes.json();
        if (!stripeRes.ok) {
          return json({ error: stripeData.error?.message || "Stripe rejected payment link" }, stripeRes.status, cors);
        }
        return json({ paymentLinkId: stripeData.id, url: stripeData.url, active: stripeData.active }, 200, cors);
      } catch (err) {
        return json({ error: err.message }, 500, cors);
      }
    }

    return json({ error: "Route not found." }, 404, cors);
  },
};
