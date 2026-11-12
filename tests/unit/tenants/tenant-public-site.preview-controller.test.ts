import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantPublicSitePreview: vi.fn(),
  listTenantPublicSiteVersions: vi.fn(),
  restoreTenantPublicSiteVersion: vi.fn(),
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: vi.fn(() => "tenant-1"),
}));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  getTenantPublicSitePreview: mocks.getTenantPublicSitePreview,
  listTenantPublicSiteVersions: mocks.listTenantPublicSiteVersions,
  restoreTenantPublicSiteVersion: mocks.restoreTenantPublicSiteVersion,
  getTenantPublicSiteEditorState: vi.fn(),
  getTenantWorkspaceSettings: vi.fn(),
  publishTenantPublicSiteDraft: vi.fn(),
  resetTenantPublicSiteDraft: vi.fn(),
  updateTenantPublicSiteDraft: vi.fn(),
  updateTenantWorkspaceSettings: vi.fn(),
}));
vi.mock("@/modules/tenants/settings/public-site-media.service.js", () => ({
  uploadTenantPublicSiteMedia: vi.fn(),
}));

import {
  getCurrentTenantPublicSitePreview,
  getCurrentTenantPublicSiteVersions,
  restoreCurrentTenantPublicSiteVersion,
} from "@/modules/tenants/settings/tenant-settings.controller.js";

const response = () => {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe("authenticated tenant public-site preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the shared config contract with private cache headers", async () => {
    const payload = {
      tenant: {
        id: "tenant-1",
        slug: "studio-olivka",
        publicSite: {},
        publicCapabilities: {},
      },
      preview: {
        mode: "authenticated",
        publicationStatus: "draft",
        hasExplicitPublicationState: false,
        publiclyAvailable: false,
      },
    };
    mocks.getTenantPublicSitePreview.mockResolvedValueOnce(payload);
    const res = response();
    const next = vi.fn();

    await getCurrentTenantPublicSitePreview(
      {} as Request,
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.getTenantPublicSitePreview).toHaveBeenCalledWith("tenant-1");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Vary", "Authorization");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  it("returns version metadata with private cache headers", async () => {
    const payload = {
      versions: [
        {
          id: "507f1f77bcf86cd799439012",
          sourceDraftRevision: 4,
          publishedAt: "2026-08-25T10:00:00.000Z",
        },
      ],
    };
    mocks.listTenantPublicSiteVersions.mockResolvedValueOnce(payload);
    const res = response();
    const next = vi.fn();

    await getCurrentTenantPublicSiteVersions(
      {} as Request,
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.listTenantPublicSiteVersions).toHaveBeenCalledWith("tenant-1");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Vary", "Authorization");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  it("validates and restores a tenant-scoped version into the draft", async () => {
    const versionId = "507f1f77bcf86cd799439012";
    const payload = { editor: { draftRevision: 5 } };
    mocks.restoreTenantPublicSiteVersion.mockResolvedValueOnce(payload);
    const res = response();
    const next = vi.fn();

    await restoreCurrentTenantPublicSiteVersion(
      { params: { versionId }, body: { revision: 4 } } as unknown as Request,
      res as unknown as Response,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.restoreTenantPublicSiteVersion).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      versionId,
      revision: 4,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(payload);
  });
});
