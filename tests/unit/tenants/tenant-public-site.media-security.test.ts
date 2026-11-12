import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadBufferToR2: vi.fn(),
  deleteObjectFromR2: vi.fn(),
  getR2PublicUrl: vi.fn(),
  updateTenantPublicSiteDraft: vi.fn(),
  getTenantPublicSiteEditorState: vi.fn(),
  assertTenantLocationIdsExist: vi.fn(),
}));

vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  uploadBufferToR2: mocks.uploadBufferToR2,
  deleteObjectFromR2: mocks.deleteObjectFromR2,
  getR2PublicUrl: mocks.getR2PublicUrl,
}));
vi.mock("@/modules/tenants/settings/tenant-settings.service.js", () => ({
  updateTenantPublicSiteDraft: mocks.updateTenantPublicSiteDraft,
  getTenantPublicSiteEditorState: mocks.getTenantPublicSiteEditorState,
}));

vi.mock("@/modules/tenant-access/services/location-scope.service.js", () => ({
  assertTenantLocationIdsExist: mocks.assertTenantLocationIdsExist,
}));

import { uploadTenantPublicSiteMedia } from "@/modules/tenants/settings/public-site-media.service.js";
import { R2ConfigurationError } from "@/config/r2-env.js";

const png = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  Buffer.from("IHDR").copy(buffer, 12);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const file = (
  buffer: Buffer,
  mimetype = "image/png",
): Pick<Express.Multer.File, "buffer" | "mimetype" | "size"> => ({
  buffer,
  mimetype,
  size: buffer.byteLength,
});

describe("tenant public-site media security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertTenantLocationIdsExist.mockResolvedValue([]);
    mocks.getR2PublicUrl.mockImplementation(
      (key: string) => `https://media.shario.test/${key}`,
    );
    mocks.uploadBufferToR2.mockResolvedValue(undefined);
    mocks.deleteObjectFromR2.mockResolvedValue(undefined);
    mocks.updateTenantPublicSiteDraft.mockResolvedValue({
      publicSite: {},
      draft: {},
      published: {},
      editor: {
        draftRevision: 3,
        publishedRevision: 1,
        hasUnpublishedChanges: true,
        draftUpdatedAt: null,
        publishedAt: null,
      },
    });
  });

  it("updates only the selected course hero, retaining localized copy and other studios with CAS", async () => {
    const locationId = "507f1f77bcf86cd799439011";
    const other = { locationId: "507f1f77bcf86cd799439012", headline: { en: "Other" }, heroImageUrl: "/other.png" };
    const selected = { locationId, headline: { cs: "Kurzy", en: "Courses" }, description: { en: "Existing copy" }, heroImageUrl: "/old.png" };
    mocks.getTenantPublicSiteEditorState.mockResolvedValue({
      draft: { customerPortal: { courses: { locations: [other, selected] } } },
      editor: { draftRevision: 9 },
    });
    const result = await uploadTenantPublicSiteMedia({
      tenantId: "tenant-alpha", slot: "courseHero", locationId, file: file(png(1200, 800)),
    });
    expect(mocks.assertTenantLocationIdsExist).toHaveBeenCalledWith("tenant-alpha", [locationId]);
    expect(mocks.updateTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-alpha", revision: 9,
      patch: { customerPortal: { courses: { locations: [
        other, { ...selected, heroImageUrl: result.media.url },
      ] } } },
    });
  });

  it("rejects a missing or foreign course-image location before writing storage", async () => {
    await expect(uploadTenantPublicSiteMedia({
      tenantId: "tenant-alpha", slot: "courseHero", file: file(png(1200, 800)),
    })).rejects.toMatchObject({ code: "COURSE_HERO_LOCATION_REQUIRED" });
    mocks.assertTenantLocationIdsExist.mockRejectedValueOnce(new Error("Foreign location"));
    await expect(uploadTenantPublicSiteMedia({
      tenantId: "tenant-alpha", slot: "courseHero", locationId: "507f1f77bcf86cd799439011", file: file(png(1200, 800)),
    })).rejects.toThrow("Foreign location");
    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
  });

  it("uses a tenant-and-slot-scoped immutable key and updates only the draft", async () => {
    const result = await uploadTenantPublicSiteMedia({
      tenantId: "tenant-alpha",
      slot: "logo",
      file: file(png(512, 512)),
      revision: 2,
    });

    expect(mocks.uploadBufferToR2).toHaveBeenCalledOnce();
    const upload = mocks.uploadBufferToR2.mock.calls[0]![0];
    expect(upload.key).toMatch(
      /^public-sites\/tenant-alpha\/logo\/[0-9]+-[0-9a-f-]+\.png$/,
    );
    expect(upload).toMatchObject({
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(mocks.updateTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-alpha",
      revision: 2,
      patch: {
        branding: {
          logoUrl: `https://media.shario.test/${upload.key}`,
        },
      },
    });
    expect(result.media).toEqual({
      slot: "logo",
      url: `https://media.shario.test/${upload.key}`,
    });
  });

  it("stores a registration image in its own slot and patches only the registration draft", async () => {
    const result = await uploadTenantPublicSiteMedia({
      tenantId: "tenant-alpha",
      slot: "registerBackground",
      file: file(png(1_920, 1_080)),
      revision: 6,
    });

    const upload = mocks.uploadBufferToR2.mock.calls[0]![0];
    expect(upload.key).toMatch(
      /^public-sites\/tenant-alpha\/registerBackground\/[0-9]+-[0-9a-f-]+\.png$/,
    );
    expect(mocks.updateTenantPublicSiteDraft).toHaveBeenCalledWith({
      tenantId: "tenant-alpha",
      revision: 6,
      patch: {
        register: {
          backgroundImageUrl: `https://media.shario.test/${upload.key}`,
        },
      },
    });
    expect(result.media).toEqual({
      slot: "registerBackground",
      url: `https://media.shario.test/${upload.key}`,
    });
  });

  it("rejects a spoofed MIME type before uploading content", async () => {
    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "cover",
        file: file(
          Buffer.from("<script>alert(document.domain)</script>"),
          "image/png",
        ),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_INVALID_CONTENT",
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
  });

  it("rejects excessive decoded image dimensions", async () => {
    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "loginBackground",
        file: file(png(6_001, 4_000)),
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "PUBLIC_SITE_MEDIA_INVALID_DIMENSIONS",
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });

  it("deletes an orphaned object when revision claiming fails", async () => {
    mocks.updateTenantPublicSiteDraft.mockRejectedValueOnce(
      Object.assign(new Error("revision conflict"), {
        statusCode: 409,
        code: "PUBLIC_SITE_REVISION_CONFLICT",
      }),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-beta",
        slot: "favicon",
        file: file(png(64, 64)),
        revision: 9,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "PUBLIC_SITE_REVISION_CONFLICT",
    });

    const uploadedKey = mocks.uploadBufferToR2.mock.calls[0]![0].key;
    expect(uploadedKey).toContain("/tenant-beta/favicon/");
    expect(mocks.deleteObjectFromR2).toHaveBeenCalledWith({
      key: uploadedKey,
    });
  });

  it("maps a storage TLS failure to a safe retryable domain error", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "write EPROTO: SSL routines:ssl3_read_bytes:ssl/tls alert handshake failure",
        ),
        { code: "EPROTO" },
      ),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "cover",
        file: file(png(1_920, 1_080)),
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "PUBLIC_SITE_MEDIA_STORAGE_UNAVAILABLE",
      message: expect.not.stringMatching(/EPROTO|ssl3_read_bytes/i),
      details: {
        reason: "secure_connection_failed",
        retryable: true,
      },
    });

    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
    expect(mocks.deleteObjectFromR2).not.toHaveBeenCalled();
  });

  it("maps a provider rejection without exposing credentials", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      Object.assign(new Error("Access key super-secret was rejected"), {
        name: "InvalidAccessKeyId",
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(512, 512)),
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "PUBLIC_SITE_MEDIA_STORAGE_UNAVAILABLE",
      message: "Image storage is unavailable. Please contact support.",
      details: {
        reason: "provider_rejected",
        retryable: false,
      },
    });

    expect(mocks.updateTenantPublicSiteDraft).not.toHaveBeenCalled();
  });

  it.each([
    [408, "transport_error"],
    [429, "provider_throttled"],
    [503, "provider_unavailable"],
  ])(
    "marks provider HTTP %i as retryable without exposing the provider error",
    async (httpStatusCode, reason) => {
      mocks.uploadBufferToR2.mockRejectedValueOnce(
        Object.assign(new Error("provider internals"), {
          $metadata: { httpStatusCode },
        }),
      );

      await expect(
        uploadTenantPublicSiteMedia({
          tenantId: "tenant-alpha",
          slot: "cover",
          file: file(png(1_280, 720)),
        }),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "PUBLIC_SITE_MEDIA_STORAGE_UNAVAILABLE",
        message: "Image storage is temporarily unavailable. Please try again.",
        details: { reason, retryable: true },
      });
    },
  );

  it("does not retry an HTTP rejection just because its message mentions a certificate", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      Object.assign(new Error("certificate authorization was rejected"), {
        $metadata: { httpStatusCode: 403 },
      }),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(512, 512)),
      }),
    ).rejects.toMatchObject({
      details: { reason: "provider_rejected", retryable: false },
    });
  });

  it("does not retry a permanent certificate validation failure", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      Object.assign(new Error("certificate has expired"), {
        code: "CERT_HAS_EXPIRED",
      }),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(512, 512)),
      }),
    ).rejects.toMatchObject({
      details: { reason: "secure_connection_failed", retryable: false },
    });
  });

  it("marks a nested network timeout as retryable", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      Object.assign(new Error("upload request failed"), {
        cause: Object.assign(new Error("socket timed out"), {
          code: "ETIMEDOUT",
        }),
      }),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(512, 512)),
      }),
    ).rejects.toMatchObject({
      details: { reason: "transport_error", retryable: true },
    });
  });

  it("does not recommend retrying an unclassified provider error", async () => {
    mocks.uploadBufferToR2.mockRejectedValueOnce(
      new Error("provider internals and api-secret-value"),
    );

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(512, 512)),
      }),
    ).rejects.toMatchObject({
      message: "Image storage is unavailable. Please contact support.",
      details: { reason: "provider_error", retryable: false },
    });
  });

  it("maps a residual public URL configuration failure to a safe non-retryable error", async () => {
    mocks.getR2PublicUrl.mockImplementationOnce(() => {
      throw new R2ConfigurationError(
        "R2_PUBLIC_URL",
        "R2_PUBLIC_URL contains api-secret-value.",
      );
    });

    await expect(
      uploadTenantPublicSiteMedia({
        tenantId: "tenant-alpha",
        slot: "logo",
        file: file(png(256, 256)),
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "PUBLIC_SITE_MEDIA_STORAGE_UNAVAILABLE",
      message: "Image storage is unavailable. Please contact support.",
      details: {
        reason: "configuration_error",
        retryable: false,
      },
    });

    expect(mocks.uploadBufferToR2).not.toHaveBeenCalled();
  });
});
