// API route: POST /api/twilio-inbound
// Twilio webhook for incoming SMS messages.
// Writes to messages table and emits an sms.inbound event to trigger automations.

const DEFAULT_SUPABASE_URL = "https://ilbrtyoeqrbkbbotoopu.supabase.co";

async function sbRest({ supabaseUrl, serviceKey, path, method, body, headers }) {
  const url = `${supabaseUrl}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: resp.ok, status: resp.status, json, text };
}

// Map Messaging Service SID → org slug (configured via env vars)
function getOrgForMessagingService(msSid) {
  const map = {
    [process.env.TWILIO_MS_VECTOR || ""]: { slug: "vector", orgId: Number(process.env.ORG_ID_VECTOR || 1) },
    [process.env.TWILIO_MS_BMG || ""]: { slug: "bmg", orgId: Number(process.env.ORG_ID_BMG || 2) },
    [process.env.TWILIO_MS_STUCCO || ""]: { slug: "stucco", orgId: Number(process.env.ORG_ID_STUCCO || 3) },
  };
  return map[msSid] || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey) {
    console.error("Missing SUPABASE_SERVICE_ROLE_KEY");
    return res.status(500).send("Server configuration error");
  }

  try {
    // Twilio sends form-encoded data
    const {
      From: from,
      To: to,
      Body: body,
      MessageSid: messageSid,
      MessagingServiceSid: msSid,
      NumMedia: numMedia,
    } = req.body || {};

    console.log("Inbound SMS:", { from, to, body: (body || "").substring(0, 50), messageSid });

    // Determine which org this belongs to
    const orgInfo = getOrgForMessagingService(msSid);
    const orgId = orgInfo?.orgId || null;
    const orgSlug = orgInfo?.slug || "unknown";

    // Try to find the contact by phone number
    let contactId = null;
    if (from && orgId) {
      const cleaned = from.replace(/\D/g, "").slice(-10);
      const contactResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/people?org_id=eq.${orgId}&phone=ilike.%25${cleaned}&select=id&limit=1`,
        method: "GET",
      });
      if (contactResp.ok && contactResp.json && contactResp.json.length > 0) {
        contactId = contactResp.json[0].id;
      }
    }

    // Save inbound message
    await sbRest({
      supabaseUrl,
      serviceKey,
      path: "/rest/v1/messages",
      method: "POST",
      body: {
        org_id: orgId,
        direction: "inbound",
        from_number: from,
        to_number: to,
        body: body || "",
        status: "received",
        twilio_sid: messageSid,
        channel: "sms",
        contact_id: contactId,
        media_count: Number(numMedia || 0),
      },
      headers: { Prefer: "return=minimal" },
    });

    // Emit sms.inbound event to trigger automations
    if (orgId) {
      const baseUrl = process.env.CRM_BASE_URL || `https://${req.headers.host}`;
      try {
        await fetch(`${baseUrl}/api/trigger-event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgId,
            orgSlug,
            eventType: "sms.inbound",
            entityType: "message",
            entityId: messageSid,
            payload: {
              from,
              to,
              body: body || "",
              contactId,
              messageSid,
            },
          }),
        });
      } catch (err) {
        console.error("Failed to emit sms.inbound event:", err.message);
      }
    }

    // Return empty TwiML (no auto-reply — automations handle responses)
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send("<Response></Response>");
  } catch (e) {
    console.error("twilio-inbound error:", e);
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send("<Response></Response>");
  }
}
