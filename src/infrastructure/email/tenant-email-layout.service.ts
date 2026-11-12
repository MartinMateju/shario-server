import { EmailTemplate } from "@/modules/email-template/email-template.model.js";
import {
  escapeEmailHtml,
  renderEmailContent,
} from "@/modules/email-template/email-template.rendering.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { PostmarkRequestError } from "./postmark.client.js";

const color = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : fallback;

/** Table-based frame works in Outlook as well as narrow mobile mail clients. */
export const renderTenantEmailFrame = ({
  body,
  header = "",
  footer = "",
  backgroundColor,
  textColor,
}: {
  body: string;
  header?: string;
  footer?: string;
  backgroundColor?: unknown;
  textColor?: unknown;
}): string => {
  const background = color(backgroundColor, "#f5f5f5");
  const foreground = color(textColor, "#1f2937");
  // Existing document renderers can be embedded without nested HTML/body tags.
  const fragment = body.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? body;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background-color:${background};font-family:Arial,Helvetica,sans-serif;color:${foreground};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background-color:#ffffff;table-layout:fixed;overflow-wrap:anywhere;">
<tr><td>${header}</td></tr><tr><td style="padding:28px 24px;font-size:16px;line-height:1.65;word-wrap:break-word;">${fragment}</td></tr><tr><td>${footer}</td></tr>
</table></td></tr></table>`;
};

/** A workspace's active default layout is its explicit choice of email branding. */
export const applyTenantEmailLayout = async (input: {
  tenantId: string;
  html?: string;
  text?: string;
  brandName: string;
  replyTo?: string;
}): Promise<string | undefined> => {
  if (!input.html?.trim() && !input.text?.trim()) return input.html;
  try {
    const layout = await EmailTemplate.findOne({
      tenant: input.tenantId,
      category: "layout",
      isDefault: true,
      isActive: true,
    })
      .select(
        "tenant category isDefault isActive headerHtml footerHtml logoUrl primaryColor",
      )
      .sort({ updatedAt: -1, _id: 1 })
      .lean()
      .exec();
    if (
      !layout ||
      String(layout.tenant) !== input.tenantId ||
      layout.category !== "layout" ||
      !layout.isDefault ||
      !layout.isActive
    )
      return input.html;
    const tenant = await TenantModel.findOne({ _id: input.tenantId })
      .select("publicSite.branding publicSiteEditor.published.branding")
      .lean()
      .exec();
    // Editor drafts must never become public through an outgoing email.
    const branding = (tenant?.publicSiteEditor?.published || tenant?.publicSite)
      ?.branding;
    const variables = {
      studioName: input.brandName,
      studio: input.brandName,
      studioEmail: input.replyTo || "",
      logo: layout.logoUrl || "",
    };
    const fragment = (source: string | undefined, fallback: string) => {
      if (!source?.trim()) return fallback;
      try {
        return renderEmailContent({
          source: { subject: "Email", htmlContent: source, format: "html" },
          locale: "cs",
          variables,
        }).html;
      } catch {
        // Malformed historical presentation must not block a transactional message.
        return fallback;
      }
    };
    return renderTenantEmailFrame({
      header: fragment(
        layout.headerHtml,
        `<p style="padding:24px;margin:0;font-size:24px;font-weight:bold;color:${color(layout.primaryColor, "#1f2937")};">${escapeEmailHtml(input.brandName)}</p>`,
      ),
      footer: fragment(
        layout.footerHtml,
        `<p style="padding:24px;margin:0;">${escapeEmailHtml(input.brandName)}</p>`,
      ),
      body:
        input.html ||
        `<div style="white-space:pre-wrap;">${escapeEmailHtml(input.text || "")}</div>`,
      backgroundColor: branding?.backgroundColor,
      textColor: branding?.textColor,
    });
  } catch {
    // No provider request has happened. Keep failures safely retryable.
    throw new PostmarkRequestError(
      "Could not prepare the workspace email layout.",
      {
        code: "EMAIL_LAYOUT_PREPARATION_FAILED",
        deliveryOutcome: "not_sent",
      },
    );
  }
};
