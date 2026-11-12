import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import { invoiceRouter, customerInvoiceRouter } from "@/modules/invoice/invoice.routes.js";
import InvoiceModel from "@/modules/invoice/invoice.schema.js";
import InvoiceSettingsModel from "@/modules/invoice/invoice-settings.schema.js";
import OrderModel from "@/modules/order/order.model.js";
import {
  createCreditNote,
  createInvoiceFromOrder,
  createManualInvoice,
  ensurePaidOrderInvoice,
  finalizeInvoice,
  getCustomerInvoiceById,
  getInvoiceById,
  listInvoices,
  reconcilePaidOrderInvoices,
  recordInvoicePayment,
  reverseInvoicePayment,
  sendInvoice,
  updateDraftInvoice,
} from "@/modules/invoice/invoice.service.js";
import { sendInvoiceEmail } from "@/modules/invoice/invoice.email.service.js";
import { getInvoiceSettings, updateInvoiceSettings } from "@/modules/invoice/invoice-settings.service.js";

afterEach(() => vi.unstubAllEnvs());

describe("native invoice feature switch", () => {
  beforeEach(() => vi.stubEnv("NATIVE_INVOICES_ENABLED", undefined));

  it.each([undefined, "", "false", "TRUE", "1"])(
    "defaults off unless explicitly enabled (%s)",
    (value) => {
      vi.stubEnv("NATIVE_INVOICES_ENABLED", value);
      expect(isNativeInvoicingEnabled()).toBe(false);
    },
  );

  it("can be explicitly re-enabled without a data migration", () => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "true");
    expect(isNativeInvoicingEnabled()).toBe(true);
  });

  it("restores the original service validation when explicitly enabled", async () => {
    vi.stubEnv("NATIVE_INVOICES_ENABLED", "true");
    await expect(createInvoiceFromOrder({ tenantId: "tenant-id", orderId: "invalid" }))
      .rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND", message: "Order not found." });
  });

  it.each([
    ["get", "/invoices"],
    ["post", "/invoices"],
    ["get", "/invoices/settings"],
    ["patch", "/invoices/settings"],
    ["post", "/invoices/from-order/order-id"],
    ["get", "/invoices/invoice-id"],
    ["patch", "/invoices/invoice-id"],
    ["get", "/invoices/invoice-id/pdf"],
    ["post", "/invoices/invoice-id/finalize"],
    ["post", "/invoices/invoice-id/send"],
    ["post", "/invoices/invoice-id/credit-notes"],
    ["post", "/invoices/invoice-id/payments"],
    ["post", "/invoices/invoice-id/payments/payment-id/reverse"],
    ["get", "/invoices/mine"],
    ["get", "/invoices/mine/invoice-id"],
    ["get", "/invoices/mine/invoice-id/pdf"],
  ] as const)("blocks %s %s before accessing data", async (method, path) => {
    const app = express();
    app.use("/invoices/mine", customerInvoiceRouter);
    app.use("/invoices", invoiceRouter);
    app.use((error: any, _req: any, res: any, _next: any) => {
      res.status(error.statusCode || 500).json({ code: error.code });
    });
    const response = await request(app)[method](path);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("INVOICE_FEATURE_DISABLED");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it.each([
    getInvoiceById, getCustomerInvoiceById, listInvoices, createManualInvoice,
    createInvoiceFromOrder, updateDraftInvoice, finalizeInvoice, sendInvoice,
    recordInvoicePayment, reverseInvoicePayment, createCreditNote,
    updateInvoiceSettings, sendInvoiceEmail,
  ])("also blocks direct service entrypoint %s", async (operation) => {
    await expect(operation({} as never)).rejects.toMatchObject({
      statusCode: 404,
      code: "INVOICE_FEATURE_DISABLED",
    });
  });

  it("blocks invoice settings reads", async () => {
    await expect(getInvoiceSettings("tenant-id")).rejects.toMatchObject({
      code: "INVOICE_FEATURE_DISABLED",
    });
  });

  it("makes payment-triggered automation and reconciliation no-ops without touching records", async () => {
    const settingsRead = vi.spyOn(InvoiceSettingsModel, "find");
    const settingsWrite = vi.spyOn(InvoiceSettingsModel, "findOneAndUpdate");
    const orderRead = vi.spyOn(OrderModel, "find");
    const orderWrite = vi.spyOn(OrderModel, "updateOne");
    const invoiceRead = vi.spyOn(InvoiceModel, "find");
    const invoiceWrite = vi.spyOn(InvoiceModel, "updateOne");

    await expect(ensurePaidOrderInvoice({ tenantId: "tenant-id", orderId: "order-id" }))
      .resolves.toEqual({ status: "disabled" });
    await expect(reconcilePaidOrderInvoices()).resolves.toEqual({
      scanned: 0, completed: 0, failed: 0, skipped: 0,
    });
    for (const operation of [settingsRead, settingsWrite, orderRead, orderWrite, invoiceRead, invoiceWrite]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
});
