import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSetupCenterSnapshot: vi.fn(),
  getSetupDiagnosticFallback: vi.fn(),
  service: {
    get: vi.fn(),
    recordEvent: vi.fn(),
    startPractice: vi.fn(),
    applyPracticeAction: vi.fn(),
    abandonPractice: vi.fn(),
    confirmPractice: vi.fn(),
    clearPracticeConfirmation: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
  },
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: vi.fn(() => "user-1"),
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: vi.fn(() => "tenant-1"),
}));
vi.mock("@/modules/setup-center/setup-center.service.js", () => ({
  default: mocks.service,
  buildSetupCenterSnapshot: mocks.buildSetupCenterSnapshot,
  getSetupDiagnosticFallback: mocks.getSetupDiagnosticFallback,
}));

import {
  confirmPractice,
  clearPracticeConfirmation,
  getSetupAssistantResponse,
  trackSetupLaunchEvent,
} from "@/modules/setup-center/setup-center.controller.js";

const response = () => {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe("Setup Center assistant controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only deterministic snapshot diagnostics and navigation", async () => {
    const snapshot = { steps: [{ id: "payments" }] };
    const diagnostic = {
      answer: "Complete Stripe verification.",
      navigation: [
        {
          stepId: "payments",
          label: "Continue setup",
          href: "/app/settings/payments?setupStep=payments",
        },
      ],
    };
    mocks.buildSetupCenterSnapshot.mockResolvedValue(snapshot);
    mocks.getSetupDiagnosticFallback.mockReturnValue(diagnostic);
    const req = {
      body: {
        message: "What should I do next?",
        stepId: "payments",
        locale: "en",
      },
    } as Request;
    const res = response();
    const next = vi.fn();

    await getSetupAssistantResponse(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocks.buildSetupCenterSnapshot).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
    });
    expect(mocks.getSetupDiagnosticFallback).toHaveBeenCalledWith({
      snapshot,
      stepId: "payments",
      locale: "en",
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: diagnostic });

    for (const operation of Object.values(mocks.service)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("accepts the shared launch event payload without trusting tenant identity", async () => {
    const body = {
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      sessionId: "launch_session_01",
      event: "step_completed",
      stepId: "location",
      source: "guided_form",
      metadata: { requirement: "required" },
    };
    mocks.service.recordEvent.mockResolvedValue({
      accepted: true,
      eventId: body.eventId,
      deduplicated: false,
    });
    const req = { body } as Request;
    const res = response();
    const next = vi.fn();

    await trackSetupLaunchEvent(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mocks.service.recordEvent).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      ...body,
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      data: {
        accepted: true,
        eventId: body.eventId,
        deduplicated: false,
      },
    });
  });

  it("confirms and clears only the authenticated tenant and actor, returning a fresh private snapshot", async () => {
    const snapshot = {
      launchReview: {
        testBooking: { complete: true, completionSource: "manual" },
      },
    };
    mocks.service.confirmPractice.mockResolvedValue(snapshot);
    const res = response();
    const next = vi.fn();
    await confirmPractice(
      {
        body: { confirmed: true, expectedReadinessFingerprint: "a".repeat(64) },
      } as Request,
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(mocks.service.confirmPractice).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
      expectedReadinessFingerprint: "a".repeat(64),
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(res.json).toHaveBeenCalledWith({ data: snapshot });

    await clearPracticeConfirmation(
      { body: { tenantId: "ignored-other-tenant" } } as Request,
      res as unknown as Response,
      next,
    );
    expect(mocks.service.clearPracticeConfirmation).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      actorUserId: "user-1",
    });
  });

  it("rejects a false confirmation before any persisted change", async () => {
    const next = vi.fn();
    await confirmPractice(
      {
        body: {
          confirmed: false,
          expectedReadinessFingerprint: "a".repeat(64),
        },
      } as Request,
      response() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: "VALIDATION_ERROR" }),
    );
    expect(mocks.service.confirmPractice).not.toHaveBeenCalled();
  });
});
