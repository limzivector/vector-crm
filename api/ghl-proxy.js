// API route: POST /api/ghl-proxy
// Proxies requests to GoHighLevel API v1 with per-org auth.
// Reads ghl_config from Supabase to get the API key for the requesting org.

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return res.status(500).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

  try {
    const { org_id, endpoint, method = "GET", body } =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    if (!org_id || !endpoint) {
      return res.status(400).json({ error: "org_id and endpoint are required" });
    }
    // Fetch GHL config for this org from Supabase
    const cfgResp = await sbRest({
      supabaseUrl, serviceKey,
      path: `/rest/v1/ghl_config?org_id=eq.${encodeURIComponent(org_id)}&limit=1`,
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const config = (cfgResp.json || [])[0];
    if (!config) {
      return res.status(404).json({ error: "GHL config not found for org: " + org_id });
    }
    if (!config.ghl_api_key) {
      return res.status(400).json({ error: "GHL API key not set for org: " + org_id });
    }

    // Build GHL API request
    const ghlUrl = `${GHL_BASE}/${endpoint.replace(/^\//, "")}`;
    const ghlHeaders = {
      Authorization: `Bearer ${config.ghl_api_key}`,
      Version: config.api_version || "2021-04-15",
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const fetchOpts = { method, headers: ghlHeaders };
    if (body && method !== "GET") {
      fetchOpts.body = JSON.stringify(body);
    }

    // Call GHL API with retry for rate limits (429)
    let ghlRes;
    for (let attempt = 0; attempt <= 3; attempt++) {
      ghlRes = await fetch(ghlUrl, fetchOpts);
      if (ghlRes.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      break;
    }

    const ghlText = await ghlRes.text().catch(() => "");
    let ghlData;
    try { ghlData = JSON.parse(ghlText); } catch (_) { ghlData = { raw: ghlText }; }

    if (!ghlRes.ok) {
      return res.status(ghlRes.status).json({
        error: "GHL API error",
        status: ghlRes.status,
        details: ghlData,
      });
    }

    return res.status(200).json(ghlData);

  } catch (err) {
    console.error("ghl-proxy error:", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
}
