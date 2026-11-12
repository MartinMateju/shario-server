import { sendManagedTenantEmail as sendEmail } from "@/infrastructure/email/managed-email.service.js";
import { escapeEmailHtml } from "@/modules/email-template/email-template.rendering.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  resolveCommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

import { renderInvoicePdf } from "./invoice.pdf.service.js";
import { INVOICE_DOCUMENT_TYPE } from "./invoice.constants.js";
import { resolveInvoiceIssuanceSnapshot } from "./invoice-issuance-snapshot.js";
import { assertNativeInvoicingEnabled } from "./invoice.feature.js";

export const sendInvoiceEmail = async ({
  invoice,
  recipient,
}: {
  invoice: any;
  recipient: string;
}) => {
  assertNativeInvoicingEnabled();
  const document = resolveInvoiceIssuanceSnapshot(invoice);
  const isCs =
    resolveCommunicationContentLocale(
      document.locale,
      COMMUNICATION_CONTENT_LOCALE.CS,
    ) ===
    COMMUNICATION_CONTENT_LOCALE.CS;
  const isCredit =
    document.documentType === INVOICE_DOCUMENT_TYPE.CREDIT_NOTE;
  const title = isCredit
    ? isCs
      ? "Opravný daňový doklad"
      : "Credit note"
    : isCs
      ? "Faktura"
      : "Invoice";
  const pdf = await renderInvoicePdf(invoice);

  return sendEmail({
    tenantId: String(invoice.tenant),
    to: recipient,
    subject: `${title} ${document.number}`,
    text: isCs
      ? `Dobrý den,\n\nv příloze najdete doklad ${document.number}.\n`
      : `Hello,\n\nPlease find document ${document.number} attached.\n`,
    html: isCs
      ? `<p>Dobrý den,</p><p>v příloze najdete doklad <strong>${escapeEmailHtml(document.number)}</strong>.</p>`
      : `<p>Hello,</p><p>Please find document <strong>${escapeEmailHtml(document.number)}</strong> attached.</p>`,
    attachments: [
      {
        filename: `${String(document.number).replace(/[^A-Z0-9_-]/gi, "_")}.pdf`,
        content: pdf,
        contentType: "application/pdf",
      },
    ],
  });
};
