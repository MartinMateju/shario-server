import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseImportFile: vi.fn(),
  getImportFileType: vi.fn(),
  sessionCreate: vi.fn(),
  sessionDeleteOne: vi.fn(),
  rowInsertMany: vi.fn(),
  rowDeleteMany: vi.fn(),
  credentialInsertMany: vi.fn(),
  credentialDeleteMany: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/modules/data-import/services/import-file-parser.service.js", () => ({
  parseImportFile: mocks.parseImportFile,
  getImportFileType: mocks.getImportFileType,
}));
vi.mock("@/modules/data-import/data-import-session.model.js", () => ({
  default: {
    create: mocks.sessionCreate,
    deleteOne: mocks.sessionDeleteOne,
  },
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: {
    insertMany: mocks.rowInsertMany,
    deleteMany: mocks.rowDeleteMany,
  },
}));
vi.mock("@/modules/data-import/data-import-credential.model.js", () => ({
  default: {
    insertMany: mocks.credentialInsertMany,
    deleteMany: mocks.credentialDeleteMany,
  },
}));
vi.mock("@/modules/data-import/services/data-import-audit.service.js", () => ({
  recordDataImportAudit: mocks.recordAudit,
}));

import { DATA_IMPORT_ENTITY } from "@/modules/data-import/data-import.constants.js";
import { createDataImportSession } from "@/modules/data-import/services/data-import.service.js";

const tenantId = new mongoose.Types.ObjectId().toString();
const actorId = new mongoose.Types.ObjectId().toString();
const sessionId = new mongoose.Types.ObjectId();
const passwordHeader = "Legacy Password Hash (bcrypt)";
const passwordHash = `$2b$12$${"A".repeat(53)}`;
const file = {
  buffer: Buffer.from("customer import"),
  originalname: "customers.csv",
  mimetype: "text/csv",
} as Express.Multer.File;

describe("customer import credential staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImportFileType.mockReturnValue("csv");
    mocks.sessionCreate.mockImplementation(async (value) => ({
      _id: sessionId,
      ...value,
      toObject: () => ({ _id: sessionId, ...value }),
    }));
    mocks.rowInsertMany.mockResolvedValue([]);
    mocks.credentialInsertMany.mockResolvedValue([]);
    mocks.recordAudit.mockResolvedValue({});
  });

  it("redacts bcrypt verifiers from stored rows and API samples", async () => {
    mocks.parseImportFile.mockResolvedValue({
      headers: ["Full Name", "Email", passwordHeader],
      rows: [
        {
          "Full Name": "Anna Novak",
          Email: "anna@example.com",
          [passwordHeader]: passwordHash,
        },
      ],
      sheetName: null,
    });

    const result = await createDataImportSession({
      tenantId,
      actorId,
      file,
      entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
    });

    expect(mocks.rowInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          raw: expect.objectContaining({
            [passwordHeader]: "[REDACTED]",
          }),
        }),
      ],
      { ordered: true },
    );
    expect(mocks.credentialInsertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenant: tenantId,
          session: sessionId,
          rowNumber: 2,
          sourceHeader: passwordHeader,
          passwordHash,
        }),
      ],
      { ordered: true },
    );
    expect(result).toMatchObject({
      credentialRowCount: 1,
      sampleRows: [{ [passwordHeader]: "[REDACTED]" }],
    });
    expect(JSON.stringify(result)).not.toContain(passwordHash);
  });

  it("rejects plaintext and unsupported password columns before persistence", async () => {
    mocks.parseImportFile.mockResolvedValue({
      headers: ["Full Name", "Password"],
      rows: [{ "Full Name": "Anna Novak", Password: "not-a-hash" }],
      sheetName: null,
    });

    await expect(
      createDataImportSession({
        tenantId,
        actorId,
        file,
        entityType: DATA_IMPORT_ENTITY.CUSTOMERS,
      }),
    ).rejects.toMatchObject({ code: "IMPORT_PASSWORD_COLUMN_UNSUPPORTED" });
    expect(mocks.sessionCreate).not.toHaveBeenCalled();
    expect(mocks.rowInsertMany).not.toHaveBeenCalled();
    expect(mocks.credentialInsertMany).not.toHaveBeenCalled();
  });
});
