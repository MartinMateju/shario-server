import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { dataImportUpload } from "@/modules/data-import/data-import-upload.middleware.js";

const app = express();
app.post("/upload", dataImportUpload, (req, res) =>
  res.status(201).json({ name: req.file?.originalname }),
);
app.use((error: any, _req, res, _next) => {
  res.status(error.statusCode || 500).json({
    code: error.code,
    message: error.message,
  });
});

describe("data import upload middleware", () => {
  it("accepts one bounded CSV file", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("file", Buffer.from("Name\nAnna"), {
        filename: "customers.csv",
        contentType: "text/csv",
      })
      .expect(201);
    expect(response.body.name).toBe("customers.csv");
  });

  it("rejects missing files and unsupported extensions", async () => {
    expect((await request(app).post("/upload").expect(400)).body.code).toBe(
      "IMPORT_FILE_REQUIRED",
    );
    expect(
      (
        await request(app)
          .post("/upload")
          .attach("file", Buffer.from("Name\nAnna"), {
            filename: "customers.xls",
            contentType: "application/vnd.ms-excel",
          })
          .expect(400)
      ).body.code,
    ).toBe("IMPORT_FILE_TYPE_INVALID");
  });

  it("rejects oversized payloads before parsing", async () => {
    const response = await request(app)
      .post("/upload")
      .attach("file", Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: "customers.csv",
        contentType: "text/csv",
      })
      .expect(413);
    expect(response.body.code).toBe("IMPORT_FILE_TOO_LARGE");
  });
});
