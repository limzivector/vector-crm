// API route: POST /api/trigger-event
// Called by the CRM frontend or other API routes to emit workflow events.
// Writes to workflow_events table in Supabase, then invokes the Trigger.dev
// workflow runner via its API.

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const triggerApiKey = process.env.TRIGGER_SECRET_KEY;

  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  try {
    const { orgId, orgSlug, eventType, entityType, entityId, payload } = req.body || {};

    if (!orgId || !eventType || !entityType) {
      return res.status(400).json({ error: "Missing required: orgId, eventType, entityType" });
    }

    // 1) Write event to workflow_events table
    const insertResp = await sbRest({
      supabaseUrl,
      serviceKey,
      path: "/rest/v1/workflow_events",
      method: "POST",
      body: {
        org_id: orgId,
        event_type: eventType,
        entity_type: entityType,
        entity_id: String(entityId || ""),
        payload: payload || {},
      },
      headers: { Prefer: "return=representation" },
    });

    if (!insertResp.ok) {
      return res.status(500).json({ error: "Failed to insert event", details: insertResp.text });
    }

    const eventRow = (insertResp.json || [])[0];
    const eventId = eventRow?.id;

    // 2) Invoke Trigger.dev task (if API key is configured)
    let triggerResult = null;
    if (triggerApiKey) {
      try {
        // Trigger.dev v3 task invocation via REST API
        const triggerResp = await fetch("https://api.trigger.dev/api/v1/tasks/process-crm-event/trigger", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${triggerApiKey}`,
          },
          body: JSON.stringify({
            payload: {
              eventId,
              orgId,
              orgSlug: orgSlug || "",
              eventType,
              entityType,
              entityId: entityId || "",
              payload: payload || {},
            },
          }),
        });

        if (triggerResp.ok) {
          triggerResult = await triggerResp.json();
        } else {
          const errText = await triggerResp.text();
          console.error("Trigger.dev invocation failed:", errText);
          triggerResult = { error: "Trigger.dev call failed", status: triggerResp.status };
        }
      } catch (triggerErr) {
        console.error("Trigger.dev invocation error:", triggerErr.message);
        triggerResult = { error: triggerErr.message };
      }
    } else {
      triggerResult = { skipped: true, reason: "TRIGGER_SECRET_KEY not configured" };
    }

    return res.status(200).json({
      ok: true,
      eventId,
      trigger: triggerResult,
    });
  } catch (e) {
    console.error("trigger-event error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}
