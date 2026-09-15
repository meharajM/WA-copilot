import { beforeEach, describe, expect, it } from "vitest";
import { useDraftStore } from "../../src/renderer/src/stores/draftStore";
import { useEmailStore } from "../../src/renderer/src/stores/emailStore";
import { useMcpStore } from "../../src/renderer/src/stores/mcpStore";
import { useWhatsAppStore } from "../../src/renderer/src/stores/whatsappStore";
import { executeToolCall } from "../../src/renderer/src/lib/mcp";
import { enforceToolCallPolicy } from "../../src/renderer/src/lib/tool-policy";

function resetEmailStore(draftMode = true): void {
  useEmailStore.setState({
    connectionState: {
      status: "disconnected",
      error: null,
      lastSyncAt: null,
      unreadCount: 0,
    },
    config: {
      accountName: "default",
      provider: "imap-smtp",
      gmailAuthMode: "app-password",
      imapHost: "",
      imapPort: 993,
      smtpHost: "",
      smtpPort: 587,
      emailAddress: "",
      userName: "",
      imapTls: true,
      smtpTls: true,
      pollingIntervalSeconds: 60,
      enabled: false,
      autoReplyMode: false,
      draftMode,
    },
  });
}

function resetWhatsAppStore(): void {
  useWhatsAppStore.setState({
    connectionState: {
      status: "disconnected",
      qrCode: null,
      error: null,
      phoneNumber: null,
      workerNumber: null,
      handshakeStatus: "idle",
    },
    whatsappEnabled: false,
    businessBotMode: false,
    targetPhoneNumber: null,
    isDialogOpen: false,
  });
}

function resetStores(): void {
  resetEmailStore();
  resetWhatsAppStore();
  useDraftStore.setState({ drafts: [] });
  useMcpStore.setState({ servers: [] });
}

describe("tool side-effect policy", () => {
  beforeEach(() => {
    resetStores();
  });

  it("converts email_send_message into a draft when draft mode is enabled", async () => {
    const result = await executeToolCall("email_send_message", {
      to: "customer@example.com",
      subject: "Order update",
      body: "Your order is on the way.",
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      status: "draft_created",
      message: "Email draft created instead of sending because draft mode is enabled.",
    });

    const [draft] = useDraftStore.getState().drafts;
    expect(draft.replyTo).toBe("customer@example.com");
    expect(draft.originalSubject).toBe("Order update");
    expect(draft.responseText).toBe("Your order is on the way.");
    expect(draft.policyDecision.rationale).toContain("Draft mode is enabled");
  });

  it("allows email_send_message when draft mode is disabled", () => {
    resetEmailStore(false);

    const policy = enforceToolCallPolicy("email_send_message", {
      to: "customer@example.com",
      subject: "Order update",
      body: "Your order is on the way.",
    });

    expect(policy.action).toBe("allow");
    expect(useDraftStore.getState().drafts).toHaveLength(0);
  });

  it("does not block explicit email_create_draft calls", () => {
    const policy = enforceToolCallPolicy("email_create_draft", {
      subject: "Order update",
      body: "Your order is on the way.",
    });

    expect(policy.action).toBe("allow");
  });

  it("blocks customer-facing WhatsApp sends when both WhatsApp send modes are disabled", () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: "connected",
        phoneNumber: "919999999999@s.whatsapp.net",
      },
      whatsappEnabled: false,
      businessBotMode: false,
    });

    const policy = enforceToolCallPolicy("whatsapp_send_message", {
      to: "918888888888@s.whatsapp.net",
      content: "Hello",
    });

    expect(policy.action).toBe("handled");
    if (policy.action === "handled") {
      expect(policy.response.error).toContain("both WhatsApp Response Permission and Autonomous Bot Mode are disabled");
    }
  });

  it("allows customer-facing WhatsApp sends in autonomous bot mode", () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: "connected",
        phoneNumber: "919999999999@s.whatsapp.net",
      },
      whatsappEnabled: false,
      businessBotMode: true,
    });

    const policy = enforceToolCallPolicy("whatsapp_send_message", {
      to: "918888888888@s.whatsapp.net",
      content: "Hello",
    });

    expect(policy).toMatchObject({
      action: "allow",
      args: { to: "918888888888@s.whatsapp.net" },
    });
  });

  it("does not fall back to the admin phone for customer-facing WhatsApp sends", () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: "connected",
        phoneNumber: "919999999999@s.whatsapp.net",
      },
      whatsappEnabled: true,
    });

    const policy = enforceToolCallPolicy("whatsapp_send_message", {
      content: "Hello",
    });

    expect(policy.action).toBe("handled");
    if (policy.action === "handled") {
      expect(policy.response.error).toContain("missing customer WhatsApp target");
    }
  });

  it("normalizes customer-facing WhatsApp sends to the configured target number", () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: "connected",
        phoneNumber: "919999999999@s.whatsapp.net",
      },
      whatsappEnabled: true,
      targetPhoneNumber: "918888888888@s.whatsapp.net",
    });

    const policy = enforceToolCallPolicy("whatsapp_send_media", {
      filePath: "/tmp/photo.png",
    });

    expect(policy).toMatchObject({
      action: "allow",
      args: { to: "918888888888@s.whatsapp.net" },
    });
  });

  it("allows admin notifications only with valid admin and customer context", () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: "connected",
        phoneNumber: "919999999999@s.whatsapp.net",
      },
    });

    const missingTarget = enforceToolCallPolicy("whatsapp_notify_admin", {
      summary: "No answer found",
      mainQuestion: "Do you ship internationally?",
    });
    expect(missingTarget.action).toBe("handled");
    if (missingTarget.action === "handled") {
      expect(missingTarget.response.error).toContain("missing customer WhatsApp target");
    }

    const adminAsCustomer = enforceToolCallPolicy("whatsapp_notify_admin", {
      to: "919999999999@s.whatsapp.net",
      summary: "No answer found",
      mainQuestion: "Do you ship internationally?",
    });
    expect(adminAsCustomer.action).toBe("handled");
    if (adminAsCustomer.action === "handled") {
      expect(adminAsCustomer.response.error).toContain("not the connected admin phone");
    }

    const valid = enforceToolCallPolicy("whatsapp_notify_admin", {
      to: "918888888888@s.whatsapp.net",
      summary: "No answer found",
      mainQuestion: "Do you ship internationally?",
    });
    expect(valid).toMatchObject({
      action: "allow",
      args: { to: "918888888888@s.whatsapp.net" },
    });
  });
});
