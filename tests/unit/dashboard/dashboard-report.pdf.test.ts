import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { buildDashboardReportSections } from "@/modules/dashboard/dashboard-report.format.js";
import { dashboardReportGeneratedLabel, renderDashboardReportPdf, wrapDashboardReportText } from "@/modules/dashboard/dashboard-report.pdf.js";
import type { DashboardReport } from "@/modules/dashboard/dashboard-report.types.js";
import { reportId, reportSnapshotFixture } from "./dashboard-report.fixtures.js";

export const pdfReportFixture = (): DashboardReport => {
  const snapshot = reportSnapshotFixture();
  return {id:reportId,generatedAt:snapshot.metadata.generatedAt,locale:"cs",sourceLocale:"cs",locationLabel:"Grohova - Brno",snapshot,
    narrative:{mode:"deterministic",headline:"Přehled vašeho studia",summary:"Za sledované období je evidováno 68 uplynulých rezervovaných návštěv. Celkové tržby za dodané služby nejsou k dispozici.",highlights:["Aktivní zákazníci za posledních 30 dní: 83."],attention:["Jedna zakázka je po termínu."],recommendations:["Prověřte termín dokončení zakázky a kontaktujte zákazníka."],dataLimitations:["Časy rezervací nepotvrzují skutečné příchody. Výše tržeb za dodané produkty není známa."]},
    sections:buildDashboardReportSections(snapshot,"cs")};
};

describe("saved studio report PDF", () => {
  it("renders Czech data across pages with immutable metadata", async () => {
    const report = pdfReportFixture();
    const bytes = await renderDashboardReportPdf(report);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getCreationDate()?.toISOString()).toBe(report.generatedAt);
    expect(pdf.getModificationDate()?.toISOString()).toBe(report.generatedAt);
    expect(pdf.getTitle()).toBe("Report studia");
    expect(bytes.subarray(0,5).toString()).toBe("%PDF-");
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(595.28);
      expect(page.getHeight()).toBeCloseTo(841.89);
    }
    // Fontsource Latin Extended excludes ASCII. Verify both subsets survive in
    // the actual embedded PDF character maps, preventing blank/tofu reports.
    const unicodeMaps=pdf.context.enumerateIndirectObjects().flatMap(([,object])=>{
      if (!(object instanceof PDFRawStream)) return [];
      const decoded=Buffer.from(decodePDFRawStream(object).decode()).toString();
      return decoded.includes("begincmap") ? [decoded] : [];
    }).join("\n");
    for (const character of ["s","k","1","ř","š","č","ě"]) {
      const unicode=character.codePointAt(0)!.toString(16).padStart(4,"0");
      expect(unicodeMaps).toMatch(new RegExp(`<\\w+>\\s*<${unicode}>`,"i"));
    }
  });

  it("wraps long identifiers without losing content or exceeding cell width", () => {
    const font = {widthOfTextAtSize: (value: string) => value.length * 5};
    const value="verylongunbrokenidentifier".repeat(20);
    const lines=wrapDashboardReportText(value,100,font,10);
    expect(lines.join("")).toBe(value);
    expect(lines.every(line=>font.widthOfTextAtSize(line)<=100)).toBe(true);
  });

  it("displays the saved generation instant in the studio timezone", () => {
    expect(dashboardReportGeneratedLabel("2026-11-07T13:05:00.000Z","cs","Europe/Prague")).toContain("14:05 | Europe/Prague");
    expect(dashboardReportGeneratedLabel("2026-07-07T13:05:00.000Z","en","Europe/Prague")).toContain("15:05 | Europe/Prague");
  });

  it("preserves unavailable revenue independently of cash totals and partial services", () => {
    const sections=buildDashboardReportSections(reportSnapshotFixture(),"en");
    expect(sections[0].rows[0].value).toBe("Unavailable");
    expect(sections[0].rows[1].label).toContain("partial");
    expect(sections.find(section=>section.key==="cash")?.rows[0].value).toContain("44,360");
    expect(sections.find(section=>section.key==="customers")?.rows[0].label).toBe("Elapsed booked visits");
  });

  it("carries customer and subscriber definitions into the sections used by PDF export", () => {
    const report=pdfReportFixture();
    const active=report.sections.find(section=>section.key==="activeCustomers")!;
    expect(active.title).toBe("Aktivní zákazníci - posledních 30 dní");
    expect(active.columns[1]).toBe("2026-10-09 - 2026-11-07");
    expect(active.rows[0].value).toBe("83");
    expect(active.notes.join(" ")).toContain("datum vytvoření rezervace");
    expect(active.notes.join(" ")).toContain("nesčítají se");
    expect(report.sections.find(section=>section.key==="memberships")?.rows[1]).toMatchObject({label:"Noví předplatitelé za období",value:"3"});
    expect(report.sections.find(section=>section.key==="registeredCustomers")?.rows[0].value).toBe("Nedostupné");
  });
});
