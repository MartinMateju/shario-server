import path from "node:path";

import ExcelJS from "exceljs";

import { badRequest } from "@/shared/http/httpErrors.js";

import { DATA_IMPORT_LIMITS } from "../data-import.constants.js";
import type { ParsedImportFile } from "../data-import.types.js";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const cleanCell = (value: unknown): string => {
  const normalized = String(value ?? "").trim();
  if (normalized.length > DATA_IMPORT_LIMITS.MAX_CELL_LENGTH) {
    badRequest({
      message:
        "A cell exceeds the " +
        DATA_IMPORT_LIMITS.MAX_CELL_LENGTH +
        "-character limit.",
      code: "IMPORT_CELL_TOO_LONG",
    });
  }
  return normalized;
};

const uniqueHeaders = (values: unknown[]): string[] => {
  const seen = new Map<string, number>();
  const headers = values.map((value, index) => {
    const base = cleanCell(value) || "Column " + (index + 1);
    if (base.length > DATA_IMPORT_LIMITS.MAX_HEADER_LENGTH) {
      badRequest({
        message: "A column header is too long.",
        code: "IMPORT_HEADER_TOO_LONG",
      });
    }
    const count = (seen.get(base.toLocaleLowerCase()) || 0) + 1;
    seen.set(base.toLocaleLowerCase(), count);
    return count === 1 ? base : base + " (" + count + ")";
  });
  if (headers.length > DATA_IMPORT_LIMITS.MAX_COLUMNS) {
    badRequest({
      message:
        "Imports can contain at most " +
        DATA_IMPORT_LIMITS.MAX_COLUMNS +
        " columns.",
      code: "IMPORT_TOO_MANY_COLUMNS",
    });
  }
  return headers;
};

const assertRowLimit = (count: number): void => {
  if (count > DATA_IMPORT_LIMITS.MAX_ROWS) {
    badRequest({
      message:
        "Imports can contain at most " +
        DATA_IMPORT_LIMITS.MAX_ROWS +
        " data rows.",
      code: "IMPORT_TOO_MANY_ROWS",
    });
  }
};

const firstLogicalRow = (text: string): string => {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      return text.slice(0, index);
    }
  }
  return text;
};

const detectDelimiter = (text: string): string => {
  const firstRow = firstLogicalRow(text);
  const candidates = [",", ";", "\t"];
  const countOutsideQuotes = (delimiter: string) => {
    let count = 0;
    let quoted = false;
    for (let index = 0; index < firstRow.length; index += 1) {
      if (firstRow[index] === '"') {
        if (quoted && firstRow[index + 1] === '"') index += 1;
        else quoted = !quoted;
      } else if (!quoted && firstRow[index] === delimiter) {
        count += 1;
      }
    }
    return count;
  };
  return candidates
    .map((delimiter) => ({ delimiter, count: countOutsideQuotes(delimiter) }))
    .sort((left, right) => right.count - left.count)[0].delimiter;
};

export const parseCsvRecords = (input: Buffer | string): string[][] => {
  const text = Buffer.isBuffer(input)
    ? input.toString("utf8").replace(/^\uFEFF/, "")
    : input.replace(/^\uFEFF/, "");
  if (text.includes("\0")) {
    badRequest({
      message: "The CSV contains unsupported null bytes.",
      code: "IMPORT_CSV_INVALID",
    });
  }

  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    record.push(cleanCell(cell));
    if (record.length > DATA_IMPORT_LIMITS.MAX_COLUMNS) {
      badRequest({
        message:
          "Imports can contain at most " +
          DATA_IMPORT_LIMITS.MAX_COLUMNS +
          " columns.",
        code: "IMPORT_TOO_MANY_COLUMNS",
      });
    }
    cell = "";
  };
  const pushRecord = () => {
    pushCell();
    if (record.some(Boolean)) records.push(record);
    record = [];
    if (records.length > DATA_IMPORT_LIMITS.MAX_ROWS + 1) {
      assertRowLimit(records.length - 1);
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (!quoted && cell.length === 0) {
        quoted = true;
      } else if (quoted) {
        quoted = false;
      } else {
        badRequest({
          message: "The CSV contains an unexpected quote.",
          code: "IMPORT_CSV_INVALID",
        });
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      pushCell();
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
      continue;
    }
    cell += character;
    if (cell.length > DATA_IMPORT_LIMITS.MAX_CELL_LENGTH) cleanCell(cell);
  }
  if (quoted) {
    badRequest({
      message: "The CSV contains an unterminated quoted value.",
      code: "IMPORT_CSV_INVALID",
    });
  }
  if (cell.length > 0 || record.length > 0) pushRecord();
  return records;
};

const recordsToParsedFile = (
  records: string[][],
  sheetName: string | null,
): ParsedImportFile => {
  if (records.length < 2) {
    badRequest({
      message: "The file must contain a header and at least one data row.",
      code: "IMPORT_FILE_EMPTY",
    });
  }
  const headers = uniqueHeaders(records[0]);
  const rows = records
    .slice(1)
    .map((record) =>
      Object.fromEntries(
        headers.map((header, index) => [header, cleanCell(record[index])]),
      ),
    );
  assertRowLimit(rows.length);
  return { headers, rows, sheetName };
};

const excelCellValue = (cell: ExcelJS.Cell): string => {
  const value = cell.value;
  if (
    value &&
    typeof value === "object" &&
    ("formula" in value || "sharedFormula" in value)
  ) {
    badRequest({
      message: "Spreadsheet formulas are not supported. Paste values first.",
      code: "IMPORT_XLSX_FORMULA_UNSUPPORTED",
    });
  }
  // Excel serial dates/times do not carry a timezone. Keeping their wall
  // components timezone-free prevents an absolute booking column from
  // silently treating a local 09:00 value as 09:00 UTC.
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  if (value && typeof value === "object" && "richText" in value) {
    return cleanCell(value.richText.map((part) => part.text).join(""));
  }
  if (value && typeof value === "object" && "text" in value) {
    return cleanCell(value.text);
  }
  return cleanCell(value);
};

const parseXlsx = async (buffer: Buffer): Promise<ParsedImportFile> => {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    badRequest({
      message: "The uploaded file is not a valid XLSX workbook.",
      code: "IMPORT_XLSX_INVALID",
    });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as never, {
      ignoreNodes: ["dataValidations"],
    });
  } catch {
    badRequest({
      message: "The uploaded XLSX workbook could not be read.",
      code: "IMPORT_XLSX_INVALID",
    });
  }

  const worksheet = workbook.worksheets.find((candidate) =>
    candidate
      .getRows(1, Math.min(candidate.rowCount, DATA_IMPORT_LIMITS.MAX_ROWS + 2))
      ?.some((row) => Array.isArray(row.values) && row.values.some(Boolean)),
  );
  if (!worksheet) {
    badRequest({
      message: "The workbook does not contain a non-empty worksheet.",
      code: "IMPORT_FILE_EMPTY",
    });
  }
  if (worksheet.actualColumnCount > DATA_IMPORT_LIMITS.MAX_COLUMNS) {
    badRequest({
      message:
        "Imports can contain at most " +
        DATA_IMPORT_LIMITS.MAX_COLUMNS +
        " columns.",
      code: "IMPORT_TOO_MANY_COLUMNS",
    });
  }
  assertRowLimit(Math.max(0, worksheet.actualRowCount - 1));

  const records: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.from(
      { length: Math.max(row.cellCount, worksheet.actualColumnCount) },
      (_, index) => excelCellValue(row.getCell(index + 1)),
    );
    if (values.some(Boolean)) records.push(values);
  });
  return recordsToParsedFile(records, worksheet.name);
};

export const getImportFileType = (originalFileName: string): "csv" | "xlsx" => {
  const extension = path.extname(originalFileName).toLowerCase();
  if (extension === ".csv") return "csv";
  if (extension === ".xlsx") return "xlsx";
  badRequest({
    message: "Only .csv and .xlsx files are supported.",
    code: "IMPORT_FILE_TYPE_INVALID",
  });
};

export const parseImportFile = async ({
  buffer,
  originalFileName,
  mimeType,
}: {
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
}): Promise<ParsedImportFile> => {
  const fileType = getImportFileType(originalFileName);
  if (
    fileType === "xlsx" &&
    mimeType !== XLSX_MIME &&
    mimeType !== "application/vnd.ms-excel" &&
    mimeType !== "application/octet-stream"
  ) {
    badRequest({
      message: "The file extension and content type do not match.",
      code: "IMPORT_FILE_TYPE_MISMATCH",
    });
  }
  if (fileType === "csv" && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    badRequest({
      message: "The file extension and content do not match.",
      code: "IMPORT_FILE_TYPE_MISMATCH",
    });
  }
  return fileType === "xlsx"
    ? parseXlsx(buffer)
    : recordsToParsedFile(parseCsvRecords(buffer), null);
};
