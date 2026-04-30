import type { APIRoute } from "astro";
import { Resend } from "resend";

export const prerender = false;

const RESEND_API_KEY = import.meta.env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = "christian@x1agent.com";
const FROM_EMAIL = import.meta.env.WEB_FROM_EMAIL ?? process.env.WEB_FROM_EMAIL ?? "x1agent <onboarding@resend.dev>";

// The Resend audience id for x1agent waitlist contacts. Set via env so
// rotating audiences (e.g. closed-beta vs open-waitlist) doesn't need
// a code change.
const AUDIENCE_ID = import.meta.env.RESEND_AUDIENCE_ID ?? process.env.RESEND_AUDIENCE_ID;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (!RESEND_API_KEY) {
    console.error("[signup] RESEND_API_KEY missing");
    return json({ ok: false, error: "Email service not configured." }, 500);
  }

  let payload: { name?: string; email?: string; intent?: string; company?: string };
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = {
        name: String(form.get("name") ?? ""),
        email: String(form.get("email") ?? ""),
        intent: String(form.get("intent") ?? ""),
        company: String(form.get("company") ?? ""),
      };
    }
  } catch {
    return json({ ok: false, error: "Could not read submission." }, 400);
  }

  // Honeypot — bots love filling every visible field. Real visitors
  // can't see this one (it's positioned off-screen). If it's filled,
  // we silently 200 so the bot thinks it succeeded.
  if (payload.company && payload.company.trim().length > 0) {
    return json({ ok: true });
  }

  const name = (payload.name ?? "").trim();
  const email = (payload.email ?? "").trim().toLowerCase();
  const intent = (payload.intent ?? "").trim();

  if (!name || !email) {
    return json({ ok: false, error: "Name and email are required." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: "That email looks off — double-check it?" }, 400);
  }

  const resend = new Resend(RESEND_API_KEY);

  const internalNotify = resend.emails.send({
    from: FROM_EMAIL,
    to: NOTIFY_EMAIL,
    replyTo: email,
    subject: `x1agent signup — ${name}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      "",
      "What they'd build first:",
      intent || "(no answer)",
      "",
      `Submitted: ${new Date().toISOString()}`,
    ].join("\n"),
  });

  const visitorAck = resend.emails.send({
    from: FROM_EMAIL,
    to: email,
    replyTo: NOTIFY_EMAIL,
    subject: "x1agent — got your request",
    text: [
      `Hey ${name.split(" ")[0]},`,
      "",
      "Thanks for the interest. I'll be in touch within a day to schedule a walk-through.",
      "",
      "Docs in the meantime: docs.x1agent.com",
      "",
      "— Christian",
    ].join("\n"),
  });

  // Add to the waitlist audience for batch follow-ups. Optional —
  // missing AUDIENCE_ID is not fatal, the founder still gets notified.
  const audienceAdd = AUDIENCE_ID
    ? resend.contacts.create({
        audienceId: AUDIENCE_ID,
        email,
        firstName: name.split(" ")[0],
        lastName: name.split(" ").slice(1).join(" ") || undefined,
        unsubscribed: false,
      })
    : Promise.resolve(null);

  const results = await Promise.allSettled([internalNotify, visitorAck, audienceAdd]);
  const failures = results.filter((r) => r.status === "rejected");

  if (failures.length === results.length) {
    console.error("[signup] all sends failed", failures);
    return json({ ok: false, error: "Could not deliver — try emailing christian@x1agent.com directly." }, 500);
  }

  if (failures.length > 0) {
    console.warn("[signup] partial failure", failures);
  }

  return json({ ok: true });
};
