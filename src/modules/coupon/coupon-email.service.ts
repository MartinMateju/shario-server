import {
  sendManagedTenantEmail,
  type ManagedEmailAttachment,
  type ManagedTenantEmailInput,
} from "@/infrastructure/email/managed-email.service.js";
import { escapeEmailHtml } from "@/modules/email-template/email-template.rendering.js";
import type { CommunicationContentLocale } from "@/shared/i18n/communication-locales.js";
import {
  buildCouponExpiryHtml,
  resolveCouponEmailContext,
  wrapCouponEmail,
} from "./coupon-email-context.js";
import type { CouponOrderDocument } from "./coupon.types.js";
import { buildVoucherPurchaseAccessUrl } from "./voucher-order-access.js";
import { AppError } from "@/shared/http/AppError.js";

export const VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES = 6 * 1024 * 1024;

type CouponEmailProduct = { name?: unknown };

const getProductName = (
  product: CouponEmailProduct,
  locale: CommunicationContentLocale,
): string => {
  if (typeof product.name === "object" && product.name !== null) {
    const localized = product.name as Record<string, string | undefined>;
    const keys = locale === "cs" ? ["cs", "CZ", "en", "EN"] : ["en", "EN", "cs", "CZ"];
    for (const key of keys) if (localized[key]) return String(localized[key]);
  }
  return typeof product.name === "string" && product.name
    ? product.name
    : locale === "cs" ? "Dárkový poukaz" : "Gift voucher";
};

export const couponEmailService = {
  /** False means the tenant has no eligible opted-in administrative recipient. */
  async prepareAdminCouponOrderEmail(params: {
    order: CouponOrderDocument;
    product: CouponEmailProduct;
    promoCodes: string[];
    templateKey: string;
  }): Promise<ManagedTenantEmailInput | null> {
    const { order, product, promoCodes, templateKey } = params;
    const context = await resolveCouponEmailContext(order);
    if (!context.adminEmail) return null;
    const cs = context.adminLocale === "cs";
    const copy = cs ? {
      title: order.sendPost ? "Objednávka poukazu k odeslání poštou" : "Potvrzení objednávky poukazu",
      detail: "Detail objednávky", product: "Produkt", template: "Šablona",
      quantity: "Počet poukazů", codes: "Kódy poukazů", name: "Jméno",
      email: "E-mail", address: "Adresa", note: "Poznámka",
    } : {
      title: order.sendPost ? "Voucher order for postal delivery" : "Voucher order confirmation",
      detail: "Order details", product: "Product", template: "Template",
      quantity: "Voucher quantity", codes: "Voucher codes", name: "Name",
      email: "Email", address: "Address", note: "Note",
    };
    const row = (label: string, value: unknown): string =>
      `<p>${label}: ${escapeEmailHtml(value)}</p>`;
    const body = `<h3>${copy.detail}</h3>
      ${row(copy.product, order.productNameSnapshot || getProductName(product, context.adminLocale))}
      ${buildCouponExpiryHtml(order, context, context.adminLocale)}
      ${row(copy.quantity, order.quantity)}
      ${row(copy.email, order.email)}
      ${row(copy.note, order.note)}
      ${order.sendPost ? [
        row(copy.template, templateKey),
        row(copy.codes, promoCodes.join(", ")),
        row(copy.name, [order.firstname, order.lastname].filter(Boolean).join(" ")),
        row(copy.address, [order.street, order.city, order.postalCode, order.countryCode].filter(Boolean).join(", ")),
      ].join("\n") : ""}`;

    return {
      // The managed sender resolves authenticated From and Reply-To per tenant.
      tenantId: String(order.tenant),
      layoutApplied: true,
      orderId: String(order._id),
      to: context.adminEmail,
      subject: `${context.brandName} | ${copy.title} | ${String(order._id)}`,
      ...wrapCouponEmail({ context, order, body }),
    } satisfies ManagedTenantEmailInput;
  },

  async prepareCustomerCouponOrderEmail(params: {
    order: CouponOrderDocument;
    attachments: ManagedEmailAttachment[];
  }): Promise<ManagedTenantEmailInput> {
    const { order, attachments } = params;
    const context = await resolveCouponEmailContext(order);
    const cs = context.locale === "cs";
    const accessUrl = context.commerceOrigin ? buildVoucherPurchaseAccessUrl({
      _id: order._id, tenant: order.tenant, localeSnapshot: order.localeSnapshot,
      purchaseAccessNonce: order.purchaseAccessNonce,
      purchaseAccessTokenHash: order.purchaseAccessTokenHash,
      purchaseAccessExpiresAt: order.purchaseAccessExpiresAt,
      purchaseOriginSnapshot: context.commerceOrigin,
    }) : undefined;
    const attachmentBytes = (attachments || []).reduce((total, attachment) => total + (
      Buffer.isBuffer(attachment.content) ? attachment.content.length :
        typeof attachment.content === "string" ? Buffer.byteLength(attachment.content) : 0
    ), 0);
    const linkOnly = attachmentBytes > VOUCHER_EMAIL_ATTACHMENT_LIMIT_BYTES;
    if (linkOnly && !accessUrl) {
      throw new AppError({ code: "VOUCHER_DELIVERY_ATTACHMENT_LIMIT", statusCode: 409,
        message: "The voucher PDFs exceed the email attachment limit and this historical purchase has no secure download link." });
    }
    const copy = cs ? {
      title: "Dárkový poukaz", greeting: "Dobrý den,",
      thanks: "děkujeme za objednávku. Vaše dárkové poukazy najdete v příloze.",
      thanksDownload: "děkujeme za objednávku. Vaše dárkové poukazy jsou připravené ke stažení. Kvůli velikosti souborů je posíláme prostřednictvím zabezpečeného odkazu.",
      download: "Stáhnout dárkové poukazy",
      postal: "Studio vytiskne a pošle vaše poukazy také na níže uvedenou adresu. Digitální poukaz si ponechte jako zálohu. Obě verze mají stejný kód a sdílejí stejnou hodnotu.",
      location: "Konkrétní místo konání najdete u vybraného kurzu nebo rezervace.",
      closing: "Přejeme příjemný den.",
    } : {
      title: "Gift voucher", greeting: "Hello,",
      thanks: "Thank you for your order. Your gift vouchers are attached.",
      thanksDownload: "Thank you for your order. Your gift vouchers are ready to download. Because of their file size, we are sending them through a secure download link.",
      download: "Download your gift vouchers",
      postal: "The studio will also print and post your vouchers to the address below. Keep the digital voucher as a backup. Both versions use the same code and share the same value.",
      location: "You can find the venue details with your chosen course or booking.",
      closing: "Have a lovely day.",
    };
    const body = `<p>${copy.greeting}</p><p>${linkOnly ? copy.thanksDownload : copy.thanks}</p>
      ${accessUrl ? `<p><a href="${escapeEmailHtml(accessUrl)}">${copy.download}</a></p>` : ""}
      ${buildCouponExpiryHtml(order, context)}
      ${order.giftMessageSnapshot ? `<p><strong>${cs ? "Věnování" : "Gift message"}:</strong><br>${escapeEmailHtml(order.giftMessageSnapshot).replace(/\n/g, "<br>")}</p>` : ""}
      ${order.sendPost ? `<p>${copy.postal}</p>${[
        [order.firstname, order.lastname].filter(Boolean).join(" "),
        order.street, order.city, order.postalCode, order.countryCode,
      ].filter(Boolean).map((value) => `<p>${escapeEmailHtml(value)}</p>`).join("\n")}` : ""}
      <p>${copy.location}</p><p>${copy.closing}</p>`;
    const rendered = wrapCouponEmail({ context, order, body });

    return {
      tenantId: String(order.tenant),
      layoutApplied: true,
      orderId: String(order._id),
      to: order.email,
      subject: `${context.brandName} | ${copy.title} | ${String(order._id)}`,
      ...rendered,
      // HTML-to-text conversion retains link labels but not href values.
      // Text-only mail readers must receive the secure URL too.
      text: accessUrl ? `${rendered.text}\n\n${copy.download}: ${accessUrl}` : rendered.text,
      attachments: linkOnly ? [] : attachments,
    } satisfies ManagedTenantEmailInput;
  },

  /** Compatibility wrappers; queued delivery prepares before its send claim. */
  async sendAdminCouponOrderEmail(params: {
    order: CouponOrderDocument;
    product: CouponEmailProduct;
    promoCodes: string[];
    templateKey: string;
  }): Promise<boolean> {
    const mail = await couponEmailService.prepareAdminCouponOrderEmail(params);
    if (!mail) return false;
    await sendManagedTenantEmail(mail);
    return true;
  },

  async sendCustomerCouponOrderEmail(params: {
    order: CouponOrderDocument;
    attachments: ManagedEmailAttachment[];
  }): Promise<void> {
    await sendManagedTenantEmail(await couponEmailService.prepareCustomerCouponOrderEmail(params));
  },

};
