import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
}));

vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
}));

import {
  loadPublishedTenant,
  type PublishedTenantRequest,
} from "@/modules/setup-center/setup-publication.middleware.js";

const response = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
};

describe("loadPublishedTenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a generic 404 for an invalid or unpublished workspace", async () => {
    const invalidResponse = response();

    await loadPublishedTenant(
      { params: { tenantSlug: "INVALID SLUG" } } as unknown as Request,
      invalidResponse,
      vi.fn() as NextFunction,
    );

    expect(mocks.findPublishedTenantBySlug).not.toHaveBeenCalled();
    expect(invalidResponse.status).toHaveBeenCalledWith(404);
    expect(invalidResponse.json).toHaveBeenCalledWith({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });

    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(null);
    const unpublishedResponse = response();

    await loadPublishedTenant(
      {
        params: { tenantSlug: "studio-grohovka" },
      } as unknown as Request,
      unpublishedResponse,
      vi.fn() as NextFunction,
    );

    expect(unpublishedResponse.status).toHaveBeenCalledWith(404);
    expect(unpublishedResponse.json).toHaveBeenCalledWith({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
  });

  it("normalizes a live slug and attaches the tenant context", async () => {
    const tenant = {
      _id: "507f1f77bcf86cd799439011",
      slug: "studio-grohovka",
      status: "active",
    };
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(tenant);
    const req = {
      params: { tenantSlug: "  STUDIO-GROHOVKA  " },
    } as unknown as PublishedTenantRequest;
    const res = response();
    const next = vi.fn();

    await loadPublishedTenant(req, res, next);

    expect(mocks.findPublishedTenantBySlug).toHaveBeenCalledWith(
      "studio-grohovka",
    );
    expect(req.params.tenantSlug).toBe("studio-grohovka");
    expect(req.tenant).toBe(tenant);
    expect(req.tenantId).toBe("507f1f77bcf86cd799439011");
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

