import crypto from "crypto";

const DEFAULT_SUPABASE_URL = "https://ilbrtyoeqrbkbbotoopu.supabase.co";

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDaysIsoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function signShareId(shareId, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(String(shareId))
    .digest("base64url");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

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
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { ok: resp.ok, status: resp.status, json, text };
}

async function validateSupabaseUser({ supabaseUrl, serviceKey, authHeader }) {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) return null;
  const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: authHeader },
  });
  if (!resp.ok) return null;
  return await resp.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const shareSecret = process.env.QUOTE_SHARE_SECRET;

  if (!serviceKey) {
    return res.status(500).json({
      error: "Missing SUPABASE_SERVICE_ROLE_KEY env var",
    });
  }
  if (!shareSecret) {
    return res.status(500).json({
      error: "Missing QUOTE_SHARE_SECRET env var",
    });
  }

  try {
    if (req.method === "POST") {
      const authHeader = req.headers.authorization || "";
      const user = await validateSupabaseUser({ supabaseUrl, serviceKey, authHeader });
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { quoteId, orgId, expiresAt } = req.body || {};
      const qid = Number(quoteId);
      if (!Number.isFinite(qid) || qid <= 0) {
        return res.status(400).json({ error: "Invalid quoteId" });
      }

      const providedOrgId = Number(orgId);
      if (orgId != null && (!Number.isFinite(providedOrgId) || providedOrgId <= 0)) {
        return res.status(400).json({ error: "Invalid orgId" });
      }

      const exp = isIsoDate(expiresAt) ? expiresAt : addDaysIsoDate(30);

      // Verify quote exists and determine org_id from DB (don’t trust client)
      const quoteResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/quotes?id=eq.${encodeURIComponent(qid)}&select=id,org_id,expires_at`,
        method: "GET",
      });
      if (!quoteResp.ok) return res.status(500).json({ error: "Supabase error", details: quoteResp.text });
      const quoteRow = (quoteResp.json || [])[0];
      if (!quoteRow) return res.status(404).json({ error: "Quote not found" });

      const dbOrgId = Number(quoteRow.org_id);
      if (Number.isFinite(providedOrgId) && providedOrgId !== dbOrgId) {
        return res.status(403).json({ error: "Org mismatch for quote" });
      }

      // Revoke any existing active share link for this quote
      await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/quote_share_links?quote_id=eq.${encodeURIComponent(qid)}&revoked_at=is.null`,
        method: "PATCH",
        body: { revoked_at: new Date().toISOString() },
        headers: { Prefer: "return=minimal" },
      });

      // Ensure quote has an expires_at date (30 days default)
      if (!quoteRow.expires_at) {
        await sbRest({
          supabaseUrl,
          serviceKey,
          path: `/rest/v1/quotes?id=eq.${encodeURIComponent(qid)}`,
          method: "PATCH",
          body: { expires_at: exp },
          headers: { Prefer: "return=minimal" },
        });
      }

      const ins = await sbRest({
        supabaseUrl,
        serviceKey,
        path: "/rest/v1/quote_share_links",
        method: "POST",
        body: { org_id: dbOrgId, quote_id: qid, expires_at: exp },
        headers: { Prefer: "return=representation" },
      });
      if (!ins.ok) return res.status(500).json({ error: "Supabase insert failed", details: ins.text });
      const row = (ins.json || [])[0];
      const shareId = row && row.id;
      if (!shareId) return res.status(500).json({ error: "Share insert missing id" });

      const sig = signShareId(shareId, shareSecret);
      const token = `${shareId}.${sig}`;
      const shareUrl = `${getBaseUrl(req)}/?quote=${encodeURIComponent(token)}`;

      return res.status(200).json({ ok: true, shareUrl, expiresAt: exp });
    }

    if (req.method === "GET") {
      const token = String(req.query.token || req.query.quote || "").trim();
      if (!token) return res.status(400).json({ error: "Missing token" });

      const parts = token.split(".");
      if (parts.length !== 2) return res.status(400).json({ error: "Invalid token" });
      const shareId = Number(parts[0]);
      const sig = parts[1];
      if (!Number.isFinite(shareId) || shareId <= 0 || !sig) {
        return res.status(400).json({ error: "Invalid token" });
      }

      const expected = signShareId(shareId, shareSecret);
      if (!safeEqual(sig, expected)) {
        // Don’t reveal if token is close/invalid.
        return res.status(404).json({ error: "Not found" });
      }

      const shareResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/quote_share_links?id=eq.${encodeURIComponent(shareId)}&select=*`,
        method: "GET",
      });
      if (!shareResp.ok) return res.status(500).json({ error: "Supabase error", details: shareResp.text });
      const share = (shareResp.json || [])[0];
      if (!share) return res.status(404).json({ error: "Not found" });
      if (share.revoked_at) return res.status(410).json({ error: "Link revoked" });

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const todayIso = `${yyyy}-${mm}-${dd}`;
      if (share.expires_at && String(share.expires_at) < todayIso) {
        return res.status(410).json({ error: "Link expired" });
      }

      // Best-effort view logging
      try {
        const nextCount = (share.view_count || 0) + 1;
        await sbRest({
          supabaseUrl,
          serviceKey,
          path: `/rest/v1/quote_share_links?id=eq.${encodeURIComponent(shareId)}`,
          method: "PATCH",
          body: { view_count: nextCount, last_viewed_at: new Date().toISOString() },
          headers: { Prefer: "return=minimal" },
        });
        share.view_count = nextCount;
        share.last_viewed_at = new Date().toISOString();
      } catch (_) {}

      const quoteId = Number(share.quote_id);

      const quoteResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}&select=*`,
        method: "GET",
      });
      if (!quoteResp.ok) return res.status(500).json({ error: "Supabase error", details: quoteResp.text });
      const quote = (quoteResp.json || [])[0];
      if (!quote) return res.status(404).json({ error: "Quote not found" });

      const itemsResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/quote_items?quote_id=eq.${encodeURIComponent(quoteId)}&select=*`,
        method: "GET",
      });
      const items = itemsResp.ok ? itemsResp.json || [] : [];

      const projectResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/projects?id=eq.${encodeURIComponent(quote.project_id)}&select=id,name,install_date,install_time,location,project_type`,
        method: "GET",
      });
      const project = projectResp.ok ? (projectResp.json || [])[0] : null;

      const orgResp = await sbRest({
        supabaseUrl,
        serviceKey,
        path: `/rest/v1/orgs?id=eq.${encodeURIComponent(quote.org_id)}&select=id,name,slug`,
        method: "GET",
      });
      const org = orgResp.ok ? (orgResp.json || [])[0] : null;

      return res.status(200).json({
        ok: true,
        org,
        project,
        quote,
        items,
        share: {
          id: share.id,
          expires_at: share.expires_at,
          view_count: share.view_count || 0,
          last_viewed_at: share.last_viewed_at || null,
        },
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("quote-share error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
}

