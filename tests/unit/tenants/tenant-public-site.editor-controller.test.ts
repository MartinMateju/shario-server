import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserId: vi.fn(() => "owner-1"),
  requireTenantId: vi.fn(() => "tenant-1"),
  getTenantPublicSiteEditorState: vi.fn(),
  getTenantPublicSitePreview: vi.fn(),
  publishTenantPublicSiteDraft: vi.fn(),
  resetTenantPublicSiteDraft: vi.fn(),
  updateTenantPublicSiteDraft: vi.fn(),
  uploadTenantPublicSiteMedia: vi.fn(),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: mocks.getAuthenticatedUserId,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.requireTenantId,
}));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  getTenantPublicSiteEditorState: mocks.getTenantPublicSiteEditorState,
  getTenantPublicSitePreview: mocks.getTenantPublicSitePreview,
  getTenantWorkspaceSettings: vi.fn(),
  publishTenantPublicSiteDraft: mocks.publishTenantPublicSiteDraft,
  resetTenantPublicSiteDraft: mocks.resetTenantPublicSiteDraft,
  updateTenantPublicSiteDraft: mocks.updateTenantPublicSiteDraft,
  updateTenantWorkspaceSettings: vi.fn(),
}));
vi.mock("@/modules/tenants/settings/public-site-media.service.js", () => ({
  uploadTenantPublicSiteMedia: mocks.uploadTenantPublicSiteMedia,
}));

import {
  getCurrentTenantPublicSite,
  publishCurrentTenantPublicSite,
  resetCurrentTenantPublicSiteDraft,
  updateCurrentTenantPublicSite,
  uploadCurrentTenantPublicSiteMedia,
} from "@/modules/tenants/settings/tenant-settings.controller.js";

const editorState = {
  publicSite: { branding: { displayName: "Draft" } },
  draft: { branding: { displayName: "Draft" } },
  published: { branding: { displayName: "Published" } },
  editor: {
    draftRevision: 4,
    publishedRevision: 3,
    hasUnpublishedChanges: true,
    draftUpdatedAt: "2026-07-29T10:00:00.000Z",
    publishedAt: "2026-07-28T10:00:00.000Z",
  },
};

const response = () => {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

const invoke = async (
  handler: (
    req: Request,
    res: Response,
    next: (error?: unknown) => void,
  ) => unknown,
  req: Partial<Request>,
) => {
  const res = response();
  const next = vi.fn();
  await handler(req as Request, res as unknown as Response, next);
  return { res, next };
};

const expectPrivateEditorResponse = (
  res: ReturnType<typeof response>,
  status = 200,
) => {
  expect(res.setHeader).toHaveBeenCalledWith(
    "Cache-Control",
    "private, no-store",
  );
  expect(res.setHeader).toHaveBeenCalledWith("Vary", "Authorization");
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledWith(editorState);
};

describe("tenant public-site editor controller contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantPublicSiteEditorState.mockResolvedValue(editorState);
    mocks.updateTenantPublicSiteDraft.mockResolvedValue(editorState);
    mocks.publishTenantPublicSiteDraft.mockResolvedValue(editorState);
    mocks.resetTenantPublicSiteDraft.mockResolvedValue(editorState);
    mocks.uploadTenantPublicSiteMedia.mockResolvedValue(editorState);
  });

  it("returns the draft/published editor state with private cache headers", async () => {
    const { res, next } = await invoke(getCurrentTenantPublicSite, {});

    expect(next).not.toHaveBeenCalled();
    expect(mocks.getTenantPublicSiteEditorState).toHaveBeenCalledWith(
      "tenant-1",
    );
    expectPrivateEditorResponse(res);
  });

  it("accepts an exact-revision draft patch and never trusts a body tenant", async () => {
    const patch = {
      branding: {
        stylePreset: "modern-minimal-v1",
      },
      pages: {
        home: {
          headline: {
            cs: "Nový návrh",
            en: "New draft",
          },
        },
      },
    };
    const { res, next } = await invoke(updateCurrentTenantPublicSite, {
      body: {
        revision: 4,
        patch,
      },
    });

    expect(next).not.toHaveBeenCalled();
    expect(mocks.updateTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      patch,
      revision: 4,
    });
    expectPrivateEditorResponse(res);
  });

  it("rejects an unknown style preset before persistence is called", async () => {
    const { res, next } = await invoke(updateCurrentTenantPublicSite, {
      body: {
        revision: 4,
        patch: {
          branding: {
            stylePreset: "future-experimental-v9",
          },
        },
      },
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("publishes through the authenticated tenant and actor identities", async () => {
    const { res, next } = await invoke(publishCurrentTenantPublicSite, {
      body: { revision: 4 },
    });

    expect(next).not.toHaveBeenCalled();
    expect(mocks.publishTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "owner-1",
      revision: 4,
    });
    expectPrivateEditorResponse(res);
  });

  it("resets the authenticated tenant draft at the requested revision", async () => {
    const { res, next } = await invoke(resetCurrentTenantPublicSiteDraft, {
      body: { revision: 4 },
    });

    expect(next).not.toHaveBeenCalled();
    expect(mocks.resetTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      revision: 4,
    });
    expectPrivateEditorResponse(res);
  });

  it("rejects unknown fields and unsafe localized page content before service code", async () => {
    const { res, next } = await invoke(updateCurrentTenantPublicSite, {
      body: {
        tenantId: "attacker-tenant",
        revision: 4,
        patch: {
          pages: {
            home: {
              headline: {
                en: "<script>alert(1)</script>",
              },
            },
          },
        },
      },
    });

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects an unknown media slot before storage is called", async () => {
    const { res, next } = await invoke(uploadCurrentTenantPublicSiteMedia, {
      params: { slot: "rawHtml" },
      body: { revision: "4" },
    });

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: "PUBLIC_SITE_MEDIA_SLOT_INVALID",
      }),
    );
    expect(mocks.uploadTenantPublicSiteMedia).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
