import { task, wait, logger } from "@trigger.dev/sdk";
import {
  getSupabase,
  loadWorkflowSteps,
  loadMatchingAutomations,
  createWorkflowRun,
  updateWorkflowRun,
  logStepExecution,
  type CrmEventType,
} from "../lib/supabase.js";
import { sendSms, getMessagingServiceForOrg } from "../lib/twilio.js";

// ------------------------------------------------------------------
// Event payload shape from the CRM
// ------------------------------------------------------------------
interface WorkflowEventPayload {
  eventId: number;
  orgId: string;
  orgSlug: string;
  eventType: CrmEventType;
  entityType: string;
  entityId: string | number;
  payload: Record<string, unknown>;
}

// ------------------------------------------------------------------
// MAIN: Process a CRM event â find matching automations â run them
// ------------------------------------------------------------------
export const processEvent = task({
  id: "process-crm-event",
  retry: { maxAttempts: 3 },
  run: async (params: WorkflowEventPayload) => {
    const { eventId, orgId, orgSlug, eventType, entityType, entityId, payload } = params;

    logger.info("Processing CRM event", { eventId, orgId, eventType, entityType, entityId });

    // Map event types to trigger types used in the automation builder
    const triggerTypeMap: Record<string, string> = {
      "lead.created": "contact_created",
      "pipeline.stage_changed": "pipeline_stage_change",
      "quote.viewed": "quote_viewed",
      "quote.sent": "quote_sent",
      "quote.signed": "quote_signed",
      "sms.inbound": "sms_received",
      "project.status_changed": "project_status_change",
      "project.created": "project_created",
      "email.received": "email_received",
    };

    const triggerType = triggerTypeMap[eventType] || eventType;
    const triggerValue = (payload.triggerValue as string) || undefined;

    // Find all published automations matching this trigger
    const automations = await loadMatchingAutomations(orgId, triggerType, triggerValue);

    if (automations.length === 0) {
      logger.info("No matching automations found", { orgId, triggerType, triggerValue });
      // Mark event as processed even if no automations matched
      const sb = getSupabase();
      await sb
        .from("workflow_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", eventId);
      return { matched: 0 };
    }

    logger.info(`Found ${automations.length} matching automations`, {
      automationIds: automations.map((a) => a.id),
    });

    // Run each matching automation
    const results = [];
    for (const automation of automations) {
      try {
        const result = await runAutomation.triggerAndWait({
          automationId: automation.id,
          automationName: automation.name,
          eventId,
          orgId,
          orgSlug,
          eventType,
          entityType,
          entityId,
          payload,
        });
        results.push({ automationId: automation.id, status: "completed", result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Automation ${automation.id} failed`, { error: errMsg });
        results.push({ automationId: automation.id, status: "failed", error: errMsg });
      }
    }

    // Mark event as processed
    const sb = getSupabase();
    await sb
      .from("workflow_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("id", eventId);

    return { matched: automations.length, results };
  },
});

// ------------------------------------------------------------------
// Run a single automation (load steps, execute sequentially)
// ------------------------------------------------------------------
interface RunAutomationParams {
  automationId: string;
  automationName: string;
  eventId: number;
  orgId: string;
  orgSlug: string;
  eventType: CrmEventType;
  entityType: string;
  entityId: string | number;
  payload: Record<string, unknown>;
}

export const runAutomation = task({
  id: "run-automation",
  retry: { maxAttempts: 1 }, // Don't retry whole automation, steps have their own retry
  run: async (params: RunAutomationParams) => {
    const { automationId, automationName, eventId, orgId, orgSlug, payload, entityId } = params;

    logger.info(`Running automation: ${automationName}`, { automationId, eventId });

    // Create a run record
    const run = await createWorkflowRun({
      org_id: orgId,
      automation_id: automationId,
      event_id: eventId,
      status: "running",
    });

    const steps = await loadWorkflowSteps(automationId);

    if (steps.length === 0) {
      logger.warn("Automation has no steps", { automationId });
      await updateWorkflowRun(run.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });
      return { runId: run.id, stepsExecuted: 0 };
    }

    let stepsExecuted = 0;
    let shouldContinue = true;

    // Build a context object that steps can read/write
    const context: Record<string, unknown> = {
      orgId,
      orgSlug,
      entityId,
      ...payload,
    };

    for (const step of steps) {
      if (!shouldContinue) break;

      const startedAt = new Date().toISOString();
      const stepType = step.stepType || step.step_type || "";
      const actionType = step.actionType || step.action_type || "";
      const config = step.config || {};

      try {
        logger.info(`Executing step ${step.stepOrder}: ${stepType}/${actionType}`, {
          stepId: step.id,
          config,
        });

        // ---- STEP EXECUTION ----
        let result: Record<string, unknown> = {};

        switch (stepType) {
          case "Trigger":
            // Trigger steps are entry points â no action needed during execution
            result = { skipped: true, reason: "trigger step" };
            break;

          case "Wait":
            result = await executeWaitStep(config);
            break;

          case "Action":
            result = await executeActionStep(actionType, config, context, orgSlug);
            break;

          case "Condition":
            const passed = evaluateCondition(config, context);
            result = { conditionPassed: passed };
            if (!passed && config.stopOnFalse) {
              shouldContinue = false;
              result.stopped = true;
            }
            break;

          default:
            result = { skipped: true, reason: `unknown stepType: ${stepType}` };
        }

        // Log successful step
        await logStepExecution({
          run_id: run.id,
          step_id: step.id,
          step_order: step.stepOrder || step.step_order,
          step_type: stepType,
          action_type: actionType,
          status: "completed",
          result,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        });

        stepsExecuted++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`Step ${step.stepOrder} failed`, { error: errMsg });

        await logStepExecution({
          run_id: run.id,
          step_id: step.id,
          step_order: step.stepOrder || step.step_order,
          step_type: stepType,
          action_type: actionType,
          status: "failed",
          error_message: errMsg,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        });

        // Stop the workflow on step failure
        await updateWorkflowRun(run.id, {
          status: "failed",
          error: errMsg,
          completed_at: new Date().toISOString(),
        });

        throw new Error(`Step ${step.stepOrder} (${actionType}) failed: ${errMsg}`);
      }
    }

    // Mark run as completed
    await updateWorkflowRun(run.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
    });

    logger.info(`Automation completed: ${automationName}`, { runId: run.id, stepsExecuted });
    return { runId: run.id, stepsExecuted };
  },
});

// ------------------------------------------------------------------
// Step executors
// ------------------------------------------------------------------

async function executeWaitStep(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const delayMinutes = Number(config.delayMinutes || config.delay_minutes || 0);
  const delayHours = Number(config.delayHours || config.delay_hours || 0);
  const delayDays = Number(config.delayDays || config.delay_days || 0);

  const totalSeconds =
    delayMinutes * 60 + delayHours * 3600 + delayDays * 86400;

  if (totalSeconds > 0) {
    logger.info(`Waiting ${totalSeconds} seconds`);
    await wait.for({ seconds: totalSeconds });
    return { waited: true, seconds: totalSeconds };
  }

  return { waited: false, reason: "no delay configured" };
}

async function executeActionStep(
  actionType: string,
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  orgSlug: string
): Promise<Record<string, unknown>> {
  switch (actionType) {
    case "send_sms": {
      const to = interpolate(String(config.to || ""), context);
      const body = interpolate(String(config.body || config.message || ""), context);

      if (!to || !body) {
        return { skipped: true, reason: "missing to or body" };
      }

      const msSid = getMessagingServiceForOrg(orgSlug);
      const result = await sendSms({ messagingServiceSid: msSid, to, body });

      // Log to messages table
      const sb = getSupabase();
      await sb.from("messages").insert({
        org_id: context.orgId,
        direction: "outbound",
        to_number: to,
        body,
        status: result.status,
        twilio_sid: result.sid,
        channel: "sms",
        contact_id: context.contactId || null,
        automation_id: context.automationId || null,
      });

      return { sent: true, sid: result.sid, status: result.status };
    }

    case "send_email": {
      const to = interpolate(String(config.to || ""), context);
      const subject = interpolate(String(config.subject || ""), context);
      const body = interpolate(String(config.body || ""), context);

      if (!to || !subject || !body) {
        return { skipped: true, reason: "missing to, subject, or body" };
      }

      // Call existing send-email API route
      const baseUrl = process.env.CRM_BASE_URL || "https://vector-crm.vercel.app";
      const resp = await fetch(`${baseUrl}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`send-email failed: ${errText}`);
      }

      return { sent: true, to, subject };
    }

    case "create_task": {
      const title = interpolate(String(config.title || "Follow up"), context);
      const description = interpolate(String(config.description || ""), context);
      const dueInDays = Number(config.dueInDays || 1);
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + dueInDays);

      const sb = getSupabase();
      const { data, error } = await sb
        .from("tasks")
        .insert({
          org_id: context.orgId,
          title,
          description,
          due_date: dueDate.toISOString().split("T")[0],
          status: "pending",
          entity_type: context.entityType || null,
          entity_id: context.entityId ? String(context.entityId) : null,
          assigned_to: config.assignedTo || null,
        })
        .select("id")
        .single();

      if (error) throw new Error(`create_task failed: ${error.message}`);
      return { created: true, taskId: data.id };
    }

    case "update_field": {
      const table = String(config.table || "");
      const field = String(config.field || "");
      const value = config.value;
      const entityId = context.entityId;

      if (!table || !field || !entityId) {
        return { skipped: true, reason: "missing table, field, or entityId" };
      }

      const sb = getSupabase();
      const { error } = await sb
        .from(table)
        .update({ [field]: value })
        .eq("id", entityId);

      if (error) throw new Error(`update_field failed: ${error.message}`);
      return { updated: true, table, field, value };
    }

    case "webhook": {
      const url = String(config.url || "");
      if (!url) return { skipped: true, reason: "no webhook URL" };

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
      });

      return { sent: true, status: resp.status };
    }

    default:
      logger.warn(`Unknown action type: ${actionType}`);
      return { skipped: true, reason: `unknown actionType: ${actionType}` };
  }
}

// ------------------------------------------------------------------
// Condition evaluator
// ------------------------------------------------------------------
function evaluateCondition(
  config: Record<string, unknown>,
  context: Record<string, unknown>
): boolean {
  const field = String(config.field || "");
  const operator = String(config.operator || "equals");
  const value = config.value;
  const actual = getNestedValue(context, field);

  switch (operator) {
    case "equals":
      return String(actual) === String(value);
    case "not_equals":
      return String(actual) !== String(value);
    case "contains":
      return String(actual).includes(String(value));
    case "not_contains":
      return !String(actual).includes(String(value));
    case "greater_than":
      return Number(actual) > Number(value);
    case "less_than":
      return Number(actual) < Number(value);
    case "is_empty":
      return !actual || actual === "" || actual === null || actual === undefined;
    case "is_not_empty":
      return !!actual && actual !== "" && actual !== null && actual !== undefined;
    default:
      logger.warn(`Unknown condition operator: ${operator}`);
      return false;
  }
}

// ------------------------------------------------------------------
// Template interpolation: "Hello {{contactName}}" â "Hello John"
// ------------------------------------------------------------------
function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => {
    const val = getNestedValue(context, path);
    return val !== undefined && val !== null ? String(val) : "";
  });
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
