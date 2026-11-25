import { spawnSync } from "node:child_process";
import ExcelJS from "exceljs";
import cron from "node-cron";
import { describe, expect, it, vi } from "vitest";

describe("security dependency compatibility", () => {
  it.each([
    ["free-text address fallback", "'[q]'.repeat(80000)"],
    ["comment-joined address", "'a' + '@b(c)'.repeat(260000)"],
  ])("bounds Nodemailer parsing for %s", (_name, payload) => {
    // GHSA-v53p-9fqp-m79j and GHSA-prgh-xp8r-p3m5 used to block the
    // event loop on these address shapes. A child process bounds a regression
    // without letting a vulnerable dependency hang the entire test runner.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `const parse = require('nodemailer/lib/addressparser');
         const result = parse(${payload});
         if (!Array.isArray(result) || result.length !== 1) process.exit(1);
         process.stdout.write('parsed');`,
      ],
      { cwd: process.cwd(), timeout: 5000, maxBuffer: 4096 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("parsed");
  });

  it("registers distinct cron tasks and executes their callbacks with the patched CommonJS UUID dependency", () => {
    const first = vi.fn();
    const second = vi.fn();
    const tasks = [
      cron.schedule("* * * * *", first, { scheduled: false }),
      cron.schedule("* * * * *", second, { scheduled: false }),
    ];
    const entries = [...cron.getTasks()].filter(([, task]) => tasks.includes(task));

    try {
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map(([id]) => id)).size).toBe(2);
      for (const [id] of entries) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      tasks[0].now("manual");
      tasks[1].now("manual");
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      for (const task of tasks) task.stop();
      for (const [id] of entries) cron.getTasks().delete(id);
    }
  });

  it("round-trips an XLSX sheet that generates UUID-backed formatting identifiers", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Import");
    sheet.addRows([[10], [20], [30]]);
    sheet.addConditionalFormatting({
      ref: "A1:A3",
      rules: [{
        type: "iconSet",
        iconSet: "3Stars",
        cfvo: [
          { type: "percent", value: 0 },
          { type: "percent", value: 33 },
          { type: "percent", value: 67 },
        ],
      }],
    });

    const data = await workbook.xlsx.writeBuffer();
    const restored = new ExcelJS.Workbook();
    await restored.xlsx.load(data);
    const restoredSheet = restored.getWorksheet("Import");
    expect(restoredSheet.getCell("A2").value).toBe(20);
    expect(restoredSheet.conditionalFormattings).toEqual([
      expect.objectContaining({
        ref: "A1:A3",
        rules: [expect.objectContaining({ type: "iconSet", iconSet: "3Stars" })],
      }),
    ]);
  });
});
