/**
 * Amy Wireless Care+ — Production Cloudflare Worker for Stripe Gateway (v2)
 * Change vs v1: /create enables automatic_payment_methods so the returned
 * client_secret can be confirmed in the browser via Stripe.js (Payment Element).
 */
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    let path = url.pathname.replace(/\/$/, "");
    // Support same-origin routing under a custom domain prefix (e.g. /api/create)
    if (path.startsWith("/api")) {
      path = path.slice(4);
    }

    if (path === "/health" || path === "/ping") {
      if (!env.STRIPE_SECRET_KEY) {
        return new Response(JSON.stringify({
          status: "error",
          error: "STRIPE_SECRET_KEY is missing from Cloudflare Worker environment variables.",
          worker: "amy-stripe-api"
        }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
      }

      try {
        const testStripe = await fetch("https://api.stripe.com/v1/balance", {
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
        });
        const stripeData = await testStripe.json();

        if (!testStripe.ok) {
          return new Response(JSON.stringify({
            status: "error",
            error: `Stripe Rejected Secret Key: ${stripeData.error?.message || "Unauthorized"}`,
            stripe_status: testStripe.status
          }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }

        const isLive = env.STRIPE_SECRET_KEY.startsWith("sk_live_");
        return new Response(JSON.stringify({
          status: "ok",
          worker: "amy-stripe-api (Online)",
          stripe_mode: isLive ? "LIVE PRODUCTION" : "TEST MODE (sk_test)",
          timestamp: new Date().toISOString()
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ status: "error", error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (!env.STRIPE_SECRET_KEY) {
      return new Response(JSON.stringify({
        error: "Missing STRIPE_SECRET_KEY in Worker environment variables."
      }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (path === "/check") {
      const intentId = url.searchParams.get("id");
      if (!intentId) {
        return new Response(JSON.stringify({ error: "Missing query parameter 'id'" }), {
          status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
          method: "GET",
          headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}` }
        });
        const data = await stripeRes.json();
        if (!stripeRes.ok) {
          return new Response(JSON.stringify({ error: data.error?.message || "Stripe lookup failed" }), {
            status: stripeRes.status, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          paymentIntentId: data.id,
          status: data.status,
          amount_received: data.amount_received,
          currency: data.currency
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (request.method === "POST" && (path === "/create" || path === "")) {
      try {
        const body = await request.json();
        const amount = parseFloat(body.amount);
        const description = body.description || "Amy Wireless Care+ Policy";
        const currency = (body.currency || "cad").toLowerCase();

        if (isNaN(amount) || amount < 0.50) {
          return new Response(JSON.stringify({ error: "Amount must be at least $0.50 CAD" }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const amountInCents = Math.round(amount * 100);

        const params = new URLSearchParams({
          amount: amountInCents.toString(),
          currency: currency,
          description: description,
        });
        params.append("automatic_payment_methods[enabled]", "true");

        const stripeResponse = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
        });

        const stripeData = await stripeResponse.json();

        if (!stripeResponse.ok) {
          return new Response(JSON.stringify({
            error: stripeData.error?.message || "Stripe API rejected creation"
          }), { status: stripeResponse.status, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }

        return new Response(JSON.stringify({
          paymentIntentId: stripeData.id,
          clientSecret: stripeData.client_secret,
          status: stripeData.status
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (path === "/cancel" && request.method === "POST") {
      try {
        const body = await request.json();
        const intentId = body.payment_intent_id;
        if (!intentId || !intentId.startsWith("pi_")) {
          return new Response(JSON.stringify({ error: "Missing or invalid payment_intent_id" }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const cancelRes = await fetch(
          `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        const cancelData = await cancelRes.json();

        if (!cancelRes.ok) {
          return new Response(JSON.stringify({ error: cancelData.error?.message || "Stripe cancel failed" }), {
            status: cancelRes.status, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          paymentIntentId: cancelData.id,
          status: cancelData.status
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (path === "/email" && request.method === "POST") {
      try {
        if (!env.BREVO_API_KEY) {
          return new Response(JSON.stringify({
            error: "BREVO_API_KEY is not configured on this Worker. Add it as a secret binding to enable email."
          }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }

        const body = await request.json();
        const to = body.to;
        const subject = body.subject || "Amy Wireless Care+";
        const html = body.html;

        if (!to || !html) {
          return new Response(JSON.stringify({ error: "Missing 'to' or 'html' in request body" }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const senderEmail = env.BREVO_SENDER_EMAIL || "warranty@amywireless.ca";
        const senderName = env.BREVO_SENDER_NAME || "Amy Wireless Care+";
        const ccEmail = env.BREVO_CC_EMAIL || "warranty@amywireless.ca";

        const emailPayload = {
          sender: { name: senderName, email: senderEmail },
          to: [{ email: to }],
          cc: [{ email: ccEmail }],
          subject: subject,
          htmlContent: html,
        };

        const brevoRes = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": env.BREVO_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(emailPayload),
        });
        const brevoData = await brevoRes.json().catch(() => ({}));

        if (!brevoRes.ok) {
          return new Response(JSON.stringify({ error: brevoData.message || `Brevo rejected (HTTP ${brevoRes.status})` }), {
            status: brevoRes.status, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          status: "sent",
          messageId: brevoData.messageId || null,
          to: to,
          cc: ccEmail
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    if (path === "/payment-link" && request.method === "POST") {
      try {
        const body = await request.json();
        const amount = parseFloat(body.amount);
        const description = body.description || "Amy Wireless Care+ Policy";

        if (isNaN(amount) || amount < 0.50) {
          return new Response(JSON.stringify({ error: "Amount must be at least $0.50 CAD" }), {
            status: 400, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const amountInCents = Math.round(amount * 100);
        const params = new URLSearchParams({
          "line_items[0][price_data][currency]": "cad",
          "line_items[0][price_data][unit_amount]": amountInCents.toString(),
          "line_items[0][price_data][product_data][name]": description,
          "line_items[0][quantity]": "1",
        });
        if (body.metadata) {
          Object.entries(body.metadata).forEach(([k, v]) => {
            params.append(`metadata[${k}]`, String(v));
          });
        }

        const stripeRes = await fetch("https://api.stripe.com/v1/payment_links", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params,
        });
        const stripeData = await stripeRes.json();

        if (!stripeRes.ok) {
          return new Response(JSON.stringify({ error: stripeData.error?.message || "Stripe rejected payment link" }), {
            status: stripeRes.status, headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        return new Response(JSON.stringify({
          paymentLinkId: stripeData.id,
          url: stripeData.url,
          active: stripeData.active
        }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Route not found. Use POST /create, POST /cancel, POST /email, POST /payment-link, or GET /check?id=" }), {
      status: 404, headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
};
