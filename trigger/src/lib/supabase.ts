import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL || "https://ilbrtyoeqrbkbbotoopu.supabase.co";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _client;
}

// ------------------------------------------------------------------
// Event types that the CRM emits → Trigger.dev consumes
// ------------------------------------------------------------------
export type CrmEventType =
  | "lead.created"
  | "pipeline.stage_changed"
  | "quote.viewed"
  | "quote.sent"
  | "quote.signed"
  | "sms.inbound"
  | "project.status_changed"
  | "project.created"
  | "email.received";

export interface CrmEvent {
  id?: number;
  org_id: number;
  event_type: CrmEventType;
  entity_type: string; // "project", "quote", "contact", etc.
  entity_id: number | string;
  payload: Record<string, unknown>;
  created_at?: string;
  processed_at?: string | null;
}

// Write an event to workflow_events table
export async function emitEvent(event: Omit<CrmEvent, "id" | "created_at" | "processed_at">) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("workflow_events")
    .insert({
      org_id: event.org_id,
      event_type: event.event_type,
      entity_type: event.entity_type,
      entity_id: String(event.entity_id),
      payload: event.payload,
    })
    .select("id")
    .single();

  if (error) throw new Error(`emitEvent failed: ${error.message}`);
  return data;
}

// Load workflow steps for a given automation, ordered by stepOrder
export async function loadWorkflowSteps(automationId: string) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("workflow_steps")
    .select("*")
    .eq("automation_id", automationId)
    .order("stepOrder", { ascending: true });

  if (error) throw new Error(`loadWorkflowSteps failed: ${error.message}`);
  return data || [];
}

// Load published automations that match a given trigger type + org
export async function loadMatchingAutomations(orgId: number, triggerType: string, triggerValue?: string) {
  const sb = getSupabase();
  let query = sb
    .from("automations")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "published")
    .eq("triggerType", triggerType);

  if (triggerValue) {
    query = query.eq("triggerValue", triggerValue);
  }

  const { data, error } = await query;
  if (error) throw new Error(`loadMatchingAutomations failed: ${error.message}`);
  return data || [];
}

// Log a workflow run
export async function createWorkflowRun(params: {
  org_id: number;
  automation_id: string;
  event_id: number;
  status: string;
}) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("workflow_runs")
    .insert(params)
    .select("id")
    .single();

  if (error) throw new Error(`createWorkflowRun failed: ${error.message}`);
  return data;
}

export async function updateWorkflowRun(runId: number, updates: Record<string, unknown>) {
  const sb = getSupabase();
  const { error } = await sb
    .from("workflow_runs")
    .update(updates)
    .eq("id", runId);

  if (error) throw new Error(`updateWorkflowRun failed: ${error.message}`);
}

// Log individual step execution
export async function logStepExecution(params: {
  run_id: number;
  step_id: number;
  step_order: number;
  step_type: string;
  action_type: string | null;
  status: string;
  result?: Record<string, unknown>;
  error_message?: string;
  started_at: string;
  completed_at?: string;
}) {
  const sb = getSupabase();
  const { error } = await sb
    .from("workflow_run_steps")
    .insert(params);

  if (error) throw new Error(`logStepExecution failed: ${error.message}`);
}
