import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  renderInvoicePdf: vi.fn(),
  resolveInvoiceIssuanceSnapshot: vi.fn(),
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));

vi.mock("@/modules/invoice/invoice.pdf.service.js", () => ({
  renderInvoicePdf: mocks.renderInvoicePdf,
}));

vi.mock("@/modules/invoice/invoice-issuance-snapshot.js", () => ({
  resolveInvoiceIssuanceSnapshot: mocks.resolveInvoiceIssuanceSnapshot,
}));

import { sendInvoiceEmail } from "@/modules/invoice/invoice.email.service.js";

const invoiceSnapshot = (locale: unknown) => ({
  documentType: "invoice",
  number: "INV-2026-0042",
  locale,
});

describe("invoice email locale fallback", () => {
  beforeEach(() => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "true");
    vi.clearAllMocks();
    mocks.renderInvoicePdf.mockResolvedValue(Buffer.from("pdf"));
    mocks.sendEmail.mockResolvedValue({ providerMessageId: "postmark-1" });
  });

  it.each(["de", "pl", "sk", "da", "fr", "es", "it", "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "uses English invoice copy for rollout locale %s",
    async (locale) => {
      mocks.resolveInvoiceIssuanceSnapshot.mockReturnValue(
        invoiceSnapshot(locale),
      );

      await sendInvoiceEmail({
        invoice: { id: "invoice-1" },
        recipient: "customer@example.test",
      });

      expect(mocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "customer@example.test",
          subject: "Invoice INV-2026-0042",
          text: expect.stringContaining(
            "Please find document INV-2026-0042 attached.",
          ),
          html: expect.stringContaining("<p>Hello,</p>"),
        }),
      );
      expect(mocks.sendEmail.mock.calls[0]?.[0]?.text).not.toContain(
        "v příloze najdete doklad",
      );
    },
  );

  it("keeps Czech as the explicit fallback for an invalid legacy locale", async () => {
    mocks.resolveInvoiceIssuanceSnapshot.mockReturnValue(
      invoiceSnapshot("not-a-locale"),
    );

    await sendInvoiceEmail({
      invoice: { id: "invoice-1" },
      recipient: "customer@example.test",
    });

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Faktura INV-2026-0042",
        text: expect.stringContaining(
          "v příloze najdete doklad INV-2026-0042.",
        ),
        html: expect.stringContaining("<p>Dobrý den,</p>"),
      }),
    );
  });
});

