// API route: POST /api/ghl-sync
// Orchestrates syncing data from GoHighLevel into the CRM.
// Supports: workflows, contacts, pipelines, opportunities, custom_fields

const DEFAULT_SUPABASE_URL = "https://ilbrtyoeqrbkbbotoopu.supabase.co";
const GHL_BASE = "https://rest.gohighlevel.com/v1";

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

async function ghlFetch(apiKey, apiVersion, endpoint) {
  const url = `${GHL_BASE}/${endpoint.replace(/^\//, "")}`;
  let res;
  for (let attempt = 0; attempt <= 3; attempt++) {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: apiVersion || "2021-04-15",
        Accept: "application/json",
      },
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      continue;
    }
    break;
  }
  const text = await res.text().catch(() => "");
  try { return JSON.parse(text); } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
  try {
    const { org_id, sync_type } =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!org_id || !sync_type) {
      return res.status(400).json({ error: "org_id and sync_type required" });
    }
    const validTypes = ["workflows", "contacts", "pipelines", "opportunities", "custom_fields"];
    if (!validTypes.includes(sync_type)) {
      return res.status(400).json({ error: "Invalid sync_type. Valid: " + validTypes.join(", ") });
    }

    const cfgResp = await sbRest({
      supabaseUrl, serviceKey,
      path: `/rest/v1/ghl_config?org_id=eq.${encodeURIComponent(org_id)}&limit=1`,
      method: "GET", headers: { Accept: "application/json" },
    });
    const config = (cfgResp.json || [])[0];
    if (!config || !config.ghl_api_key) {
      return res.status(400).json({ error: "GHL not configured for org: " + org_id });
    }

    const logResp = await sbRest({
      supabaseUrl, serviceKey, path: "/rest/v1/ghl_sync_log", method: "POST",
      body: { org_id, sync_type, status: "running" },
      headers: { Prefer: "return=representation" },
    });
    const logId = (logResp.json || [])[0]?.id;
    let recordsSynced = 0;

    try {
      if (sync_type === "workflows") recordsSynced = await syncWorkflows(supabaseUrl, serviceKey, config, org_id);
      else if (sync_type === "contacts") recordsSynced = await syncContacts(supabaseUrl, serviceKey, config, org_id);
      else if (sync_type === "pipelines") recordsSynced = await syncPipelines(supabaseUrl, serviceKey, config, org_id);
      else if (sync_type === "opportunities") recordsSynced = await syncOpportunities(supabaseUrl, serviceKey, config, org_id);
      else if (sync_type === "custom_fields") recordsSynced = await syncCustomFields(supabaseUrl, serviceKey, config, org_id);

      if (logId) {
        await sbRest({ supabaseUrl, serviceKey,
          path: `/rest/v1/ghl_sync_log?id=eq.${logId}`, method: "PATCH",
          body: { status: "completed", records_synced: recordsSynced, completed_at: new Date().toISOString() },
        });
      }
      await sbRest({ supabaseUrl, serviceKey,
        path: `/rest/v1/ghl_config?org_id=eq.${encodeURIComponent(org_id)}`, method: "PATCH",
        body: { last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      });
      return res.status(200).json({ success: true, sync_type, records_synced: recordsSynced });
    } catch (syncErr) {
      if (logId) {
        await sbRest({ supabaseUrl, serviceKey,
          path: `/rest/v1/ghl_sync_log?id=eq.${logId}`, method: "PATCH",
          body: { status: "failed", error_message: syncErr.message, completed_at: new Date().toISOString() },
        });
      }
      throw syncErr;
    }
  } catch (err) {
    console.error("ghl-sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}
// --- Sync: Workflows ---
async function syncWorkflows(supabaseUrl, serviceKey, config, org_id) {
  const data = await ghlFetch(config.ghl_api_key, config.api_version,
    'workflows/');
  const workflows = data.workflows || [];
  let count = 0;
  for (const wf of workflows) {
    await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/ghl_entity_map", method: "POST",
      body: { org_id, entity_type: "workflow", ghl_id: wf.id, ghl_data: wf, synced_at: new Date().toISOString() },
      headers: { Prefer: "resolution=merge-duplicates" },
    });
    const autoName = wf.name || "Untitled Workflow";
    const autoStatus = wf.status === "published" ? "active" : (wf.status || "draft");
    const existResp = await sbRest({ supabaseUrl, serviceKey,
      path: `/rest/v1/automations?org_id=eq.${encodeURIComponent(org_id)}&triggerValue=eq.${wf.id}&triggerType=eq.ghl_workflow&limit=1`,
      method: "GET", headers: { Accept: "application/json" },
    });
    const existing = (existResp.json || [])[0];
    if (existing) {
      await sbRest({ supabaseUrl, serviceKey,
        path: `/rest/v1/automations?id=eq.${encodeURIComponent(existing.id)}`, method: "PATCH",
        body: { name: autoName, status: autoStatus, folder: "GHL Synced" },
      });
    } else {
      const newId = org_id + "-ghl-" + wf.id.substring(0, 8);
      await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/automations", method: "POST",
        body: { id: newId, org_id, name: autoName, status: autoStatus,
          triggerType: "ghl_workflow", triggerValue: wf.id, folder: "GHL Synced" },
      });
    }
    count++;
  }
  return count;
}

// --- Sync: Contacts ---
async function syncContacts(supabaseUrl, serviceKey, config, org_id) {
  let count = 0, hasMore = true, afterId = null;
  while (hasMore) {
    let ep = 'contacts/?limit=100';
    if (afterId) ep += `&startAfterId=${afterId}`;
    const data = await ghlFetch(config.ghl_api_key, config.api_version, ep);
    const contacts = data.contacts || [];
    for (const c of contacts) {
      await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/ghl_entity_map", method: "POST",
        body: { org_id, entity_type: "contact", ghl_id: c.id, ghl_data: c, synced_at: new Date().toISOString() },
        headers: { Prefer: "resolution=merge-duplicates" },
      });
      count++;
    }
    hasMore = contacts.length >= 100 && !!data.meta?.nextPageUrl;
    if (hasMore) afterId = contacts[contacts.length - 1].id;
  }
  return count;
}
// --- Sync: Pipelines ---
async function syncPipelines(supabaseUrl, serviceKey, config, org_id) {
  const data = await ghlFetch(config.ghl_api_key, config.api_version,
    'pipelines/');
  let count = 0;
  for (const p of (data.pipelines || [])) {
    await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/ghl_entity_map", method: "POST",
      body: { org_id, entity_type: "pipeline", ghl_id: p.id, ghl_data: p, synced_at: new Date().toISOString() },
      headers: { Prefer: "resolution=merge-duplicates" },
    });
    count++;
  }
  return count;
}

// --- Sync: Opportunities ---
async function syncOpportunities(supabaseUrl, serviceKey, config, org_id) {
  let count = 0;
  const pData = await ghlFetch(config.ghl_api_key, config.api_version,
    'pipelines/');
  for (const pipeline of (pData.pipelines || [])) {
    let page = 1, hasMore = true;
    while (hasMore) {
      const data = await ghlFetch(config.ghl_api_key, config.api_version,
        `pipelines/${pipeline.id}/opportunities`);
      const opps = data.opportunities || [];
      for (const o of opps) {
        await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/ghl_entity_map", method: "POST",
          body: { org_id, entity_type: "opportunity", ghl_id: o.id, ghl_data: o, synced_at: new Date().toISOString() },
          headers: { Prefer: "resolution=merge-duplicates" },
        });
        count++;
      }
      hasMore = opps.length >= 100;
      page++;
    }
  }
  return count;
}

// --- Sync: Custom Fields ---
async function syncCustomFields(supabaseUrl, serviceKey, config, org_id) {
  const data = await ghlFetch(config.ghl_api_key, config.api_version,
    'custom-fields/');
  let count = 0;
  for (const f of (data.customFields || [])) {
    await sbRest({ supabaseUrl, serviceKey, path: "/rest/v1/ghl_entity_map", method: "POST",
      body: { org_id, entity_type: "custom_field", ghl_id: f.id, ghl_data: f, synced_at: new Date().toISOString() },
      headers: { Prefer: "resolution=merge-duplicates" },
    });
    count++;
  }
  return count;
}
