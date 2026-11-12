import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  parseCsvRecords,
  parseImportFile,
} from "@/modules/data-import/services/import-file-parser.service.js";
import {
  normalizeBookingImportRow,
  validateBookingImportRow,
} from "@/modules/data-import/adapters/booking-import.adapter.js";
import { DATA_IMPORT_LIMITS } from "@/modules/data-import/data-import.constants.js";

describe("data import file parser", () => {
  it("parses UTF-8 BOM, quoted commas, escaped quotes and line breaks", async () => {
    const csv = Buffer.from(
      '\uFEFFFull Name,Mail,Note\r\n"Anna Novak",anna@example.com,"Clay, ""white"""\r\n"Jan\nNovak",jan@example.com,ok\r\n',
    );
    const parsed = await parseImportFile({
      buffer: csv,
      originalFileName: "customers.csv",
      mimeType: "text/csv",
    });

    expect(parsed.headers).toEqual(["Full Name", "Mail", "Note"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].Note).toBe('Clay, "white"');
    expect(parsed.rows[1]["Full Name"]).toBe("Jan\nNovak");
  });

  it("detects semicolon-separated Czech exports", () => {
    expect(
      parseCsvRecords("Jméno;Příjmení;Mobil\nAnna;Nováková;+420777123456"),
    ).toEqual([
      ["Jméno", "Příjmení", "Mobil"],
      ["Anna", "Nováková", "+420777123456"],
    ]);
  });

  it("rejects a CSV data row that exceeds the column limit", () => {
    const cells = Array.from(
      { length: DATA_IMPORT_LIMITS.MAX_COLUMNS + 1 },
      (_, index) => String(index),
    );

    expect(() => parseCsvRecords(`Name\n${cells.join(",")}`)).toThrow(
      expect.objectContaining({ code: "IMPORT_TOO_MANY_COLUMNS" }),
    );
  });

  it("rejects malformed CSV and extension/content spoofing", async () => {
    expect(() => parseCsvRecords('Name,Email\n"Anna,anna@example.com')).toThrow(
      expect.objectContaining({ code: "IMPORT_CSV_INVALID" }),
    );
    await expect(
      parseImportFile({
        buffer: Buffer.from("PK fake workbook"),
        originalFileName: "customers.csv",
        mimeType: "text/csv",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_TYPE_MISMATCH" });
  });

  it("reads the first non-empty XLSX sheet without evaluating formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Empty");
    const sheet = workbook.addWorksheet("Customers");
    sheet.addRow(["Full Name", "Email"]);
    sheet.addRow(["Anna Novak", "anna@example.com"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await parseImportFile({
      buffer,
      originalFileName: "customers.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(parsed.sheetName).toBe("Customers");
    expect(parsed.rows[0]).toEqual({
      "Full Name": "Anna Novak",
      Email: "anna@example.com",
    });

    await expect(
      parseImportFile({
        buffer,
        originalFileName: "customers.xlsx",
        mimeType: "application/vnd.ms-excel",
      }),
    ).resolves.toMatchObject({ sheetName: "Customers" });

    sheet.getCell("A2").value = { formula: "1+1", result: 2 };
    const formulaBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(
      parseImportFile({
        buffer: formulaBuffer,
        originalFileName: "customers.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_XLSX_FORMULA_UNSUPPORTED" });
  });

  it("keeps typed Excel booking dates and times timezone-free", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Bookings");
    sheet.addRow([
      "Service",
      "Date",
      "From",
      "To",
      "Absolute Start",
      "Absolute End",
    ]);
    sheet.addRow([
      "Wheel Class",
      new Date(Date.UTC(2026, 8, 15)),
      new Date(Date.UTC(1899, 11, 30, 9, 15)),
      new Date(Date.UTC(1899, 11, 30, 11, 45)),
      new Date(Date.UTC(2026, 8, 15, 9)),
      new Date(Date.UTC(2026, 8, 15, 11)),
    ]);
    sheet.getColumn(2).numFmt = "yyyy-mm-dd";
    sheet.getColumn(3).numFmt = "hh:mm";
    sheet.getColumn(4).numFmt = "hh:mm";
    sheet.getColumn(5).numFmt = "yyyy-mm-dd hh:mm";
    sheet.getColumn(6).numFmt = "yyyy-mm-dd hh:mm";

    const parsed = await parseImportFile({
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      originalFileName: "bookings.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    expect(parsed.rows[0]).toMatchObject({
      Date: "2026-09-15T00:00:00",
      From: "1899-12-30T09:15:00",
      To: "1899-12-30T11:45:00",
      "Absolute Start": "2026-09-15T09:00:00",
      "Absolute End": "2026-09-15T11:00:00",
    });

    const split = normalizeBookingImportRow(parsed.rows[0], {
      productName: "Service",
      date: "Date",
      startTime: "From",
      endTime: "To",
    });
    expect(split).toMatchObject({
      productName: "Wheel Class",
      date: "2026-09-15",
      startTime: "09:15",
      endTime: "11:45",
      start: "",
      end: "",
    });
    expect(validateBookingImportRow(split)).toEqual([]);

    const absolute = normalizeBookingImportRow(parsed.rows[0], {
      productName: "Service",
      start: "Absolute Start",
      end: "Absolute End",
    });
    expect(absolute.start).toBe("");
    expect(absolute.end).toBe("");
    expect(validateBookingImportRow(absolute)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BOOKING_START_INVALID" }),
        expect.objectContaining({ code: "BOOKING_END_INVALID" }),
      ]),
    );
  });
});
