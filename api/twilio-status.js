// API route: POST /api/twilio-status
// Twilio status callback webhook. Updates message delivery status in Supabase.

const DEFAULT_SUPABASE_URL = "https://ilbrtyoeqrbkbbotoopu.supabase.co";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceKey) return res.status(200).end(); // Silently fail — don't block Twilio

  try {
    const {
      MessageSid: messageSid,
      MessageStatus: messageStatus,
      ErrorCode: errorCode,
      ErrorMessage: errorMessage,
    } = req.body || {};

    if (!messageSid || !messageStatus) return res.status(200).end();

    console.log("SMS status update:", { messageSid, messageStatus, errorCode });

    // Update the message record
    const url = `${supabaseUrl}/rest/v1/messages?twilio_sid=eq.${encodeURIComponent(messageSid)}`;
    const updateBody = {
      status: messageStatus,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
      updated_at: new Date().toISOString(),
    };

    await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(updateBody),
    });

    return res.status(200).end();
  } catch (e) {
    console.error("twilio-status error:", e);
    return res.status(200).end(); // Always return 200 to Twilio
  }
}
