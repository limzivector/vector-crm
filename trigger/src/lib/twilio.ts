// Twilio helper for sending SMS via Messaging Service
// Uses the Twilio REST API directly (no SDK dependency needed for simple sends)

const TWILIO_ACCOUNT_SID = () => process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = () => process.env.TWILIO_AUTH_TOKEN || "";

export interface SendSmsParams {
  messagingServiceSid: string; // per-org messaging service
  to: string;
  body: string;
  statusCallback?: string;
}

export interface SendSmsResult {
  sid: string;
  status: string;
  to: string;
  body: string;
}

export async function sendSms(params: SendSmsParams): Promise<SendSmsResult> {
  const accountSid = TWILIO_ACCOUNT_SID();
  const authToken = TWILIO_AUTH_TOKEN();

  if (!accountSid || !authToken) {
    throw new Error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
  }

  // Check kill switch
  if (process.env.TWILIO_DISABLED === "true") {
    throw new Error("Twilio is disabled via TWILIO_DISABLED env var");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const formBody = new URLSearchParams({
    MessagingServiceSid: params.messagingServiceSid,
    To: params.to,
    Body: params.body,
  });

  if (params.statusCallback) {
    formBody.set("StatusCallback", params.statusCallback);
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Twilio send failed: ${data.message || JSON.stringify(data)}`);
  }

  return {
    sid: data.sid,
    status: data.status,
    to: data.to,
    body: data.body,
  };
}

// Org → Messaging Service SID mapping
// After A2P campaigns are approved, update these with real SIDs
export const ORG_MESSAGING_SERVICES: Record<string, string> = {
  vector: process.env.TWILIO_MS_VECTOR || "",
  bmg: process.env.TWILIO_MS_BMG || "",
  stucco: process.env.TWILIO_MS_STUCCO || "",
};

export function getMessagingServiceForOrg(orgSlug: string): string {
  const sid = ORG_MESSAGING_SERVICES[orgSlug];
  if (!sid) throw new Error(`No Messaging Service SID configured for org: ${orgSlug}`);
  return sid;
}
