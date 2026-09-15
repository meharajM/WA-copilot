import { useDraftStore } from "../stores/draftStore";
import { useEmailStore } from "../stores/emailStore";
import { useWhatsAppStore } from "../stores/whatsappStore";
import { createDraftResponse } from "./email-policy";
import { isSameWhatsAppIdentity } from "../../../shared/whatsappIdentity";

export type ToolPolicyResult =
  | { action: "allow"; args?: Record<string, unknown> }
  | { action: "handled"; response: { result: unknown; error?: string } };

type WhatsAppPolicyKind = "customer-send" | "admin-notify";

const CUSTOMER_WHATSAPP_TOOLS = new Set([
  "whatsapp_send_message",
  "whatsapp_send_media",
]);

const ADMIN_NOTIFY_TOOLS = new Set([
  "whatsapp_notify_admin",
  "whatsapp_admin_notify",
]);

function readStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getWhatsAppTarget(args: Record<string, unknown>, kind: WhatsAppPolicyKind): string | undefined {
  const explicitTarget = readStringArg(args, ["to", "customerJid", "targetJid", "jid"]);
  if (explicitTarget) return explicitTarget;

  const state = useWhatsAppStore.getState();
  if (kind === "customer-send") {
    return state.targetPhoneNumber || undefined;
  }

  return undefined;
}

function enforceEmailSendPolicy(args: Record<string, unknown>): ToolPolicyResult {
  const { config } = useEmailStore.getState();
  if (!config.draftMode) return { action: "allow" };

  const to = readStringArg(args, ["to"]);
  const subject = readStringArg(args, ["subject"]) || "(No Subject)";
  const body = readStringArg(args, ["body", "content"]);

  if (!to || !body) {
    return {
      action: "handled",
      response: {
        result: null,
        error:
          "Email send blocked by draft mode, but a draft could not be created because 'to' or 'body' is missing.",
      },
    };
  }

  const draft = createDraftResponse(
    body,
    {
      action: "draft",
      confidence: 0.5,
      rationale: "Draft mode is enabled; direct email send was converted to a draft.",
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    },
    {
      from: to,
      subject,
      to,
      inReplyTo: args.inReplyTo as string | undefined,
      references: args.references as string | undefined,
      accountName: args.accountName as string | undefined,
    }
  );

  useDraftStore.getState().addDraft(draft);

  return {
    action: "handled",
    response: {
      result: {
        status: "draft_created",
        draftId: draft.id,
        message: "Email draft created instead of sending because draft mode is enabled.",
      },
    },
  };
}

function enforceWhatsAppPolicy(
  toolName: string,
  args: Record<string, unknown>,
  kind: WhatsAppPolicyKind
): ToolPolicyResult {
  const state = useWhatsAppStore.getState();
  const adminJid = state.connectionState.phoneNumber || undefined;
  const targetJid = getWhatsAppTarget(args, kind);

  if (state.connectionState.status !== "connected") {
    return {
      action: "handled",
      response: {
        result: null,
        error: `${toolName} blocked: WhatsApp is not connected.`,
      },
    };
  }

  if (!adminJid) {
    return {
      action: "handled",
      response: {
        result: null,
        error: `${toolName} blocked: connected admin phone number is not available.`,
      },
    };
  }

  if (kind === "customer-send") {
    if (!state.whatsappEnabled && !state.businessBotMode) {
      return {
        action: "handled",
        response: {
          result: null,
          error:
            `${toolName} blocked: both WhatsApp Response Permission and Autonomous Bot Mode are disabled, so the agent cannot send customer-facing messages.`,
        },
      };
    }

    if (!targetJid) {
      return {
        action: "handled",
        response: {
          result: null,
          error:
            `${toolName} blocked: missing customer WhatsApp target. Provide 'to' or configure a target phone number.`,
        },
      };
    }

    return { action: "allow", args: { ...args, to: targetJid } };
  }

  if (!targetJid) {
    return {
      action: "handled",
      response: {
        result: null,
        error:
          `${toolName} blocked: missing customer WhatsApp target for admin notification. Provide 'to' or 'customerJid'.`,
      },
    };
  }

  if (isSameWhatsAppIdentity(targetJid, adminJid)) {
    return {
      action: "handled",
      response: {
        result: null,
        error:
          `${toolName} blocked: admin notification target must be a customer JID, not the connected admin phone.`,
      },
    };
  }

  return { action: "allow", args: { ...args, to: targetJid } };
}

export function enforceToolCallPolicy(
  toolName: string,
  args: Record<string, unknown>
): ToolPolicyResult {
  if (toolName === "email_send_message") {
    return enforceEmailSendPolicy(args);
  }

  if (CUSTOMER_WHATSAPP_TOOLS.has(toolName)) {
    return enforceWhatsAppPolicy(toolName, args, "customer-send");
  }

  if (ADMIN_NOTIFY_TOOLS.has(toolName)) {
    return enforceWhatsAppPolicy(toolName, args, "admin-notify");
  }

  return { action: "allow" };
}
