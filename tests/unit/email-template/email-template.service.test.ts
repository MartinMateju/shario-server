import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  automationExists: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  findByIdForTenant: vi.fn(),
  findDocumentByIdForTenant: vi.fn(),
  list: vi.fn(),
  setDefault: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/modules/communication-automations/communication-automation.model.js", () => ({
  default: {
    exists: mocks.automationExists,
  },
}));
vi.mock("@/modules/email-template/email-template.repository.js", () => ({
  emailTemplateRepository: {
    create: mocks.create,
    delete: mocks.delete,
    findByIdForTenant: mocks.findByIdForTenant,
    findDocumentByIdForTenant: mocks.findDocumentByIdForTenant,
    list: mocks.list,
    setDefault: mocks.setDefault,
    update: mocks.update,
  },
}));
vi.mock("@/shared/http/httpErrors.js", () => ({
  badRequest: (message: string) => {
    throw new Error(`400:${message}`);
  },
  conflict: (message: string) => {
    throw new Error(`409:${message}`);
  },
  notFound: (message: string) => {
    throw new Error(`404:${message}`);
  },
}));

import { emailTemplateService } from "@/modules/email-template/services/email-template.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const USER_ID = "507f191e810c19729de860ea";
const TEMPLATE_ID = "507f191e810c19729de860eb";

const automationQuery = (result: unknown) => ({
  exec: vi.fn().mockResolvedValue(result),
});

const templateDocument = (overrides: Record<string, unknown> = {}) => {
  const values = {
    _id: TEMPLATE_ID,
    category: "general",
    subject: "Subject",
    htmlContent: "<p>Body</p>",
    body: "Body",
    format: "html",
    defaultLocale: "cs",
    contentVariants: {},
    headerHtml: "",
    footerHtml: "",
    isActive: true,
    isDefault: false,
    variables: [],
    ...overrides,
  };
  return {
    ...values,
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn().mockReturnValue({ ...values }),
  };
};

describe("email template service safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.automationExists.mockReturnValue(automationQuery(null));
    mocks.findByIdForTenant.mockResolvedValue({ _id: TEMPLATE_ID });
    mocks.setDefault.mockResolvedValue(templateDocument({ isDefault: true }));
  });

  it("creates a requested default inactive first, then switches the category atomically", async () => {
    mocks.create.mockResolvedValue(templateDocument());

    await emailTemplateService.create(TENANT_ID, USER_ID, {
      name: "Default",
      category: "general",
      subject: "Subject",
      htmlContent: "<p>Body</p>",
      body: "",
      defaultLocale: "cs",
      contentVariants: {},
      headerHtml: "",
      footerHtml: "",
      logoUrl: "",
      primaryColor: "#111111",
      variables: [],
      isActive: true,
      isDefault: true,
    } as never);

    expect(mocks.create).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      expect.objectContaining({ isDefault: false }),
    );
    expect(mocks.setDefault).toHaveBeenCalledWith(
      TENANT_ID,
      TEMPLATE_ID,
      "general",
    );
  });

  it("does not persist a content template emptied by HTML sanitization", async () => {
    await expect(
      emailTemplateService.create(TENANT_ID, USER_ID, {
        name: "Sanitized empty",
        category: "general",
        subject: "Subject",
        htmlContent: "",
        body: "",
        format: "html",
        defaultLocale: "en",
        contentVariants: {},
        headerHtml: "",
        footerHtml: "",
        logoUrl: "",
        primaryColor: "#111111",
        variables: [],
        isActive: true,
        isDefault: true,
      } as never),
    ).rejects.toThrow(
      "400:At least one complete localized email variant is required.",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.setDefault).not.toHaveBeenCalled();
  });

  it("keeps the legacy top-level fields synchronized with the default variant", async () => {
    const existing = templateDocument({
      contentVariants: {
        cs: { subject: "Old", htmlContent: "<p>Old</p>", body: "", format: "html" },
      },
    });
    mocks.findDocumentByIdForTenant.mockResolvedValue(existing);
    mocks.update.mockResolvedValue(existing);

    await emailTemplateService.update(TENANT_ID, TEMPLATE_ID, {
      defaultLocale: "en",
      contentVariants: {
        en: {
          subject: "English",
          htmlContent: "<p>Hello {{firstName}}</p>",
          body: "Hello {{firstName}}",
          format: "html",
        },
      },
    } as never);

    expect(mocks.update).toHaveBeenCalledWith(
      TENANT_ID,
      TEMPLATE_ID,
      expect.objectContaining({
        subject: "English",
        htmlContent: "<p>Hello {{firstName}}</p>",
        body: "Hello {{firstName}}",
        format: "html",
        variables: ["firstName"],
      }),
    );
  });

  it("replaces localized variants so clearing a locale cannot leave stale content", async () => {
    const existing = templateDocument({
      defaultLocale: "cs",
      contentVariants: {
        cs: { subject: "Česky", htmlContent: "<p>Ahoj</p>", format: "html" },
        en: { subject: "English", htmlContent: "<p>Hello</p>", format: "html" },
      },
    });
    mocks.findDocumentByIdForTenant.mockResolvedValue(existing);
    mocks.update.mockResolvedValue(existing);

    await emailTemplateService.update(TENANT_ID, TEMPLATE_ID, {
      defaultLocale: "cs",
      contentVariants: {
        cs: {
          subject: "Nově česky",
          htmlContent: "<p>Nový obsah</p>",
          body: "",
          format: "html",
        },
      },
    } as never);

    expect(mocks.update).toHaveBeenCalledWith(
      TENANT_ID,
      TEMPLATE_ID,
      expect.objectContaining({
        contentVariants: {
          cs: expect.objectContaining({ subject: "Nově česky" }),
        },
      }),
    );
    const update = mocks.update.mock.calls[0][2];
    expect(update.contentVariants.en).toBeUndefined();
  });

  it("prevents deactivating a template used by an active automation", async () => {
    mocks.findDocumentByIdForTenant.mockResolvedValue(templateDocument());
    mocks.automationExists.mockReturnValue(automationQuery({ _id: "automation" }));

    await expect(
      emailTemplateService.toggleActive(TENANT_ID, TEMPLATE_ID),
    ).rejects.toThrow("409:An active automation uses this email template.");
  });

  it("prevents converting a template used by an active automation into a layout", async () => {
    mocks.findDocumentByIdForTenant.mockResolvedValue(templateDocument());
    mocks.automationExists.mockReturnValue(automationQuery({ _id: "automation" }));

    await expect(
      emailTemplateService.update(TENANT_ID, TEMPLATE_ID, {
        category: "layout",
        subject: "",
        htmlContent: "",
        body: "",
        contentVariants: {},
      } as never),
    ).rejects.toThrow(
      "409:An active automation requires this template to remain a complete content template.",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("prevents deleting any template that remains referenced", async () => {
    mocks.automationExists.mockReturnValue(automationQuery({ _id: "automation" }));

    await expect(
      emailTemplateService.delete(TENANT_ID, TEMPLATE_ID),
    ).rejects.toThrow("409:This email template is referenced by an automation");
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
