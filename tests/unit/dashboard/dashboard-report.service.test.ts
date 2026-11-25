import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  build: vi.fn(), entitlement: vi.fn(), execute: vi.fn(), scope: vi.fn(), create: vi.fn(), find: vi.fn(), pdf: vi.fn(), location: vi.fn(),
}));
vi.mock("@/modules/dashboard/dashboard-management.service.js", () => ({ buildDashboardManagement: mocks.build }));
vi.mock("@/modules/ai/services/ai-access.service.js", () => ({ requireAiEntitlement: mocks.entitlement }));
vi.mock("@/modules/ai/services/ai-orchestrator.service.js", () => ({ executeStructuredAi: mocks.execute }));
vi.mock("@/modules/reports/reports.scope.js", () => ({ resolveReportLocationScope: mocks.scope }));
vi.mock("@/modules/dashboard/dashboard-report.model.js", () => ({ DashboardReportModel: {create:mocks.create,findOne:mocks.find} }));
vi.mock("@/modules/dashboard/dashboard-report.pdf.js", () => ({ renderDashboardReportPdf: mocks.pdf }));
vi.mock("@/modules/location/location.model.js", () => ({ default: {findOne:mocks.location} }));

import {
  assertDashboardReportScope,
  dashboardReportFacts,
  deterministicDashboardReportNarrative,
  exportDashboardReportPdf,
  generateDashboardReport,
} from "@/modules/dashboard/dashboard-report.service.js";
import type { DashboardReportRecord } from "@/modules/dashboard/dashboard-report.model.js";
import { dashboardReportLimitations } from "@/modules/dashboard/dashboard-report.coverage.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { creatorId, locationId, metric, reportContextFixture, reportId, reportSnapshotFixture, tenantId } from "./dashboard-report.fixtures.js";

const recordFixture = (): DashboardReportRecord => ({
  _id:reportId,tenant:tenantId,creator:creatorId,locationIds:[locationId],unrestricted:false,
  requiredReadPermissions:[WORKSPACE_PERMISSION.WORKSPACE_VIEW,WORKSPACE_PERMISSION.REPORTS_VIEW,WORKSPACE_PERMISSION.BOOKINGS_VIEW],
  generatedAt:"2026-11-07T13:05:00.000Z",locale:"cs",sourceLocale:"cs",locationLabel:"Grohova",
  snapshot:reportSnapshotFixture(),narrative:{...deterministicDashboardReportNarrative(reportSnapshotFixture(),"cs"),mode:"deterministic"},sections:[],aiRunId:null,
}) as unknown as DashboardReportRecord;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlement.mockResolvedValue({settings:{defaultLocale:"cs"}});
  mocks.scope.mockResolvedValue({locationIds:[locationId],allowedLocationIds:[locationId],requestedLocationId:locationId,unrestricted:false});
  mocks.build.mockResolvedValue(reportSnapshotFixture());
  mocks.execute.mockImplementation(async options=>({value:await options.fallback(),provider:"deterministic",runId:"run",credits:0}));
  mocks.location.mockReturnValue({select:()=>({lean:async()=>({name:"Grohova"})})});
  mocks.create.mockImplementation(async value=>({toObject:()=>({_id:reportId,...value})}));
  mocks.pdf.mockResolvedValue(Buffer.from("%PDF-saved-report"));
});

describe("studio report generation", () => {
  it("protects workspace product purchase rankings in saved selected-studio reports", async () => {
    const snapshot = reportSnapshotFixture();
    snapshot.topProducts = { available: true, complete: true, scope: "workspace", basis: "paid_purchases",
      period: { from: "2026-10-18", to: "2026-11-16" },
      items: [{ id: "product", name: "Product", purchaseCount: 2, quantity: 3, revenueMinor: null }] };
    mocks.build.mockResolvedValue(snapshot);
    const owner = reportContextFixture();
    owner.access.locationAccess = { mode: "all", locationIds: [] };
    await generateDashboardReport({ context: owner, query: { locationId }, locale: "en" });
    const saved = { _id: reportId, ...mocks.create.mock.calls[0][0] } as DashboardReportRecord;
    expect(saved.unrestricted).toBe(true);
    expect(() => assertDashboardReportScope(reportContextFixture(), saved)).toThrow();
  });
  it("reports recorded payments in major units and protects workspace aggregates", async () => {
    const snapshot = reportSnapshotFixture();
    snapshot.metadata.revenueBasis = "recorded_net_payments";
    snapshot.metadata.revenueScope = "workspace";
    snapshot.summary.recordedPaymentsMinor = metric(12345, 6789);
    snapshot.summary.recordedPaymentsComplete = false;
    const facts = dashboardReportFacts(snapshot);
    expect(facts.summary.recordedPayments).toMatchObject({ value: 123.45, previous: 67.89 });
    expect(facts.summary.recordedPaymentsMinor).toBeUndefined();
    expect(facts.summary.deliveredRevenue).toBeUndefined();
    expect(facts.revenueBreakdown).toBeUndefined();
    expect(facts.metadata).toMatchObject({ revenueBasis: "recorded_net_payments", revenueScope: "workspace" });
    mocks.build.mockResolvedValue(snapshot);
    const owner = reportContextFixture();
    owner.access.locationAccess = { mode: "all", locationIds: [] };
    const report = await generateDashboardReport({ context: owner, query: { locationId }, locale: "en" });
    expect(report.sections[0].title).toBe("Recorded payments - whole workspace");
    expect(report.sections[0].rows).toHaveLength(1);
    expect(report.sections[0].rows[0].value).toContain("123.45");
    expect(report.sections[0].notes.join(" ")).toContain("Only verified payment amounts");
    expect(report.narrative.highlights.join(" ")).toContain("Recorded payments after refunds");
    const saved = { _id: reportId, ...mocks.create.mock.calls[0][0] } as DashboardReportRecord;
    expect(saved.unrestricted).toBe(true);
    expect(() => assertDashboardReportScope(reportContextFixture(), saved)).toThrow();
  });
  it("retains unrestricted scope for selected-studio reports containing workspace spending", async () => {
    const snapshot=reportSnapshotFixture();
    snapshot.topClients.spendingAvailable=true;
    snapshot.topClients.spendingScope="workspace";
    snapshot.topClients.byVisits=[{id:creatorId,name:"Private Customer",visits:2,revenueMinor:null,memberNumber:42,spentMonthMinor:12345,spentTotalMinor:98765}];
    mocks.build.mockResolvedValue(snapshot);
    mocks.scope.mockResolvedValue({locationIds:[locationId],allowedLocationIds:null,requestedLocationId:locationId,unrestricted:false});
    const owner=reportContextFixture();
    owner.access.locationAccess={mode:"all",locationIds:[]};
    await generateDashboardReport({context:owner,query:{locationId},locale:"cs"});
    const saved={_id:reportId,...mocks.create.mock.calls[0][0]} as DashboardReportRecord;
    expect(saved.unrestricted).toBe(true);
    expect(()=>assertDashboardReportScope(owner,saved)).not.toThrow();
    expect(()=>assertDashboardReportScope(reportContextFixture(),saved)).toThrow();
    expect(JSON.stringify(dashboardReportFacts(snapshot))).not.toMatch(/Private Customer|12345|98765/);
    mocks.find.mockReturnValue({lean:async()=>saved});
    await expect(exportDashboardReportPdf({context:reportContextFixture(),reportId})).rejects.toMatchObject({statusCode:404});
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
  it("saves one server-calculated snapshot and labels deterministic fallback", async () => {
    const source=reportSnapshotFixture();
    mocks.build.mockResolvedValue(source);
    const result=await generateDashboardReport({context:reportContextFixture(),query:{date:"2026-11-07",locationId},locale:"cs"});
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(result.narrative.mode).toBe("deterministic");
    expect(result.narrative.summary).toContain("bez AI");
    expect(result.snapshot.summary.deliveredRevenueMinor.value).toBeNull();
    expect(result.snapshot.cash.receivedMinor.value).toBe(4436000);
    expect(result.sections[0].rows[0].value).toBe("Nedostupné");
    expect(mocks.create.mock.calls[0][0]).toMatchObject({tenant:tenantId,creator:creatorId,locationIds:[locationId]});
    source.summary.visits.value=999;
    expect(result.snapshot.summary.visits.value).toBe(68);
  });

  it("sends aggregate major-unit money to AI without personal free text", () => {
    const snapshot=reportSnapshotFixture();
    const facts=dashboardReportFacts(snapshot);
    expect(facts.cash.received.value).toBe(44360);
    expect(facts.cash.complete).toBe(false);
    expect(facts.revenueBreakdown.documentedServices.value).toBe(1200);
    expect(facts.summary.deliveredRevenue.value).toBeNull();
    expect(JSON.stringify(facts)).not.toContain("Private Customer");
    expect(JSON.stringify(facts)).not.toContain("soukromé zadání");
    expect(JSON.stringify(facts)).not.toContain(creatorId);
    expect(facts.customers).toMatchObject({total:{value:null},activeLast30Days:{value:83},scope:"workspace",activeScope:"selected_locations"});
    expect(facts.memberships.newSubscribers).toMatchObject({value:3,previous:2});
    expect(facts.metadata).toMatchObject({activeCustomersBasis:"booking_created",registeredCustomersBasis:"customer_record_created",activeCustomerWindowDays:30,activeCustomerPeriod:{from:"2026-10-09",to:"2026-11-07"}});
  });

  it("retains separate customer windows and subscriber definitions in saved sections and fallback", async () => {
    const source=reportSnapshotFixture();
    source.customers!.total=metric(1601,1572);
    source.customers!.new=metric(29,17);
    mocks.build.mockResolvedValue(source);
    const result=await generateDashboardReport({context:reportContextFixture(),query:{locationId},locale:"en"});
    const customers=result.sections.find(section=>section.key==="registeredCustomers")!;
    const active=result.sections.find(section=>section.key==="activeCustomers")!;
    const members=result.sections.find(section=>section.key==="memberships")!;
    expect(customers.title).toContain("whole workspace");
    expect(customers.rows[0].value).toBe("1,601");
    expect(customers.rows[1].value).toBe("29");
    expect(active.columns.slice(1)).toEqual(["2026-10-09 - 2026-11-07","2026-09-08 - 2026-10-07"]);
    expect(active.rows[0]).toMatchObject({value:"83",previous:"72"});
    expect(active.notes.join(" ")).toContain("booking creation date");
    expect(active.notes.join(" ")).toContain("may be in the future");
    expect(active.notes.join(" ")).toContain("do not add them together");
    expect(members.rows.slice(0,2)).toEqual([
      {label:"Active subscribers - available snapshot",value:"32",previous:"Unavailable"},
      {label:"New subscribers during period",value:"3",previous:"2"},
    ]);
    expect(members.notes.join(" ")).toContain("renewals, plan changes and reactivations do not count");
    expect(result.narrative.highlights.join(" ")).toMatch(/1,601.*29.*83.*32.*3/);
    expect(mocks.execute.mock.calls[0][0].instructions).toContain("Never sum");
    expect(mocks.execute.mock.calls[0][0].promptVersion).toBe("dashboard-management-report-v3-payments");
    source.customers!.activeLast30Days.value=999;
    expect(result.snapshot.customers!.activeLast30Days.value).toBe(83);
  });

  it("protects workspace customer totals in saved selected-studio reports", async () => {
    const source=reportSnapshotFixture();
    source.customers!.total=metric(1601,1572);
    source.customers!.new=metric(29,17);
    mocks.build.mockResolvedValue(source);
    const owner=reportContextFixture();
    owner.access.locationAccess={mode:"all",locationIds:[]};
    await generateDashboardReport({context:owner,query:{locationId},locale:"cs"});
    const saved={_id:reportId,...mocks.create.mock.calls[0][0]} as DashboardReportRecord;
    expect(saved.unrestricted).toBe(true);
    expect(()=>assertDashboardReportScope(owner,saved)).not.toThrow();
    expect(()=>assertDashboardReportScope(reportContextFixture(),saved)).toThrow();
  });

  it("accepts grounded AI wording for the explicitly supplied active-customer period", async () => {
    const source=reportSnapshotFixture();
    source.metadata.activeCustomerPeriod={from:"2026-10-09",to:"2026-11-07"};
    mocks.build.mockResolvedValue(source);
    mocks.execute.mockResolvedValue({provider:"openai",runId:"run",value:{headline:"Studio report",summary:"83 customers created a booking in the last 30 days, 2026-10-09 to 2026-11-07.",highlights:[],attention:[],recommendations:[],dataLimitations:[]}});
    const result=await generateDashboardReport({context:reportContextFixture(),query:{locationId},locale:"en"});
    expect(result.narrative.mode).toBe("ai");
    expect(result.narrative.summary).toContain("last 30 days");
  });

  it("keeps unavailable workspace totals unavailable without restricting branch-only exports", async () => {
    const result=await generateDashboardReport({context:reportContextFixture(),query:{locationId},locale:"en"});
    expect(result.sections.find(section=>section.key==="registeredCustomers")?.rows.map(row=>row.value)).toEqual(["Unavailable","Unavailable"]);
    expect(mocks.create.mock.calls[0][0].unrestricted).toBe(false);
    expect(result.narrative.highlights.join(" ")).not.toContain("Total customers at period cutoff");
    expect(result.narrative.highlights.join(" ")).toContain("83");
  });

  it("rejects invented AI figures and retains all coverage limitations", async () => {
    mocks.execute.mockResolvedValue({provider:"openai",runId:"run",value:{headline:"Report",summary:"Revenue is 999999.",highlights:[],attention:[],recommendations:[],dataLimitations:[]}});
    const result=await generateDashboardReport({context:reportContextFixture(),query:{locationId},locale:"en"});
    expect(result.narrative.mode).toBe("deterministic");
    expect(result.narrative.summary).not.toContain("999999");
    expect(result.narrative.dataLimitations).toContain("Delivered revenue: reliable delivery records are missing.");
    expect(result.narrative.dataLimitations.join(" ")).not.toContain("missing_fulfillment_evidence");
  });

  it("accepts an AI summary only when grounded in the snapshot", async () => {
    mocks.execute.mockResolvedValue({provider:"openai",runId:"run",value:{headline:"Studio report",summary:"There were 68 elapsed booked visits.",highlights:[],attention:[],recommendations:[],dataLimitations:[]}});
    const result=await generateDashboardReport({context:reportContextFixture(),query:{locationId},locale:"en"});
    expect(result.narrative.mode).toBe("ai");
    expect(result.narrative.dataLimitations.length).toBeGreaterThan(0);
  });

  it("denies generation before reading data when AI permission is absent", async () => {
    const context=reportContextFixture();
    context.access.permissions=context.access.permissions.filter(permission=>permission!==WORKSPACE_PERMISSION.AI_USE);
    await expect(generateDashboardReport({context,query:{}})).rejects.toMatchObject({statusCode:403});
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("saves the audit permission required to retain access to email issues", async () => {
    const context=reportContextFixture();
    context.access.permissions=[...context.access.permissions,WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW];
    await generateDashboardReport({context,query:{locationId},locale:"cs"});
    const saved={_id:reportId,...mocks.create.mock.calls[0][0]} as DashboardReportRecord;
    expect(saved.requiredReadPermissions).toContain(WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW);
    context.access.permissions=context.access.permissions.filter(permission=>permission!==WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW);
    expect(()=>assertDashboardReportScope(context,saved)).toThrow();
  });

  it("localizes coverage and current issue keys without exposing implementation codes", () => {
    const snapshot=reportSnapshotFixture();
    snapshot.issues.push({key:"failed_emails",count:3,href:"/app/communications"},{key:"overdue_invoices",count:2,href:"/app/finance/invoices"});
    snapshot.coverage.unavailable.push({source:"emailIssues",reason:"permission_denied"});
    const narrative=deterministicDashboardReportNarrative(snapshot,"cs");
    expect(narrative.attention).toContain("Nedoručené e-maily: 3.");
    expect(narrative.attention).toContain("Faktury po splatnosti: 2.");
    expect(narrative.dataLimitations.join(" ")).toContain("Skutečná docházka se neeviduje");
    expect(narrative.dataLimitations.join(" ")).not.toMatch(/permission_denied|emailIssues|missing_fulfillment_evidence/);
    expect(dashboardReportLimitations(snapshot,"en")).toContain("Email issues: you do not have permission to view these records.");
  });
});

describe("saved report export authorization", () => {
  it("renders the persisted snapshot without regenerating live metrics or AI", async () => {
    const record=recordFixture();
    mocks.find.mockReturnValue({lean:async()=>record});
    const result=await exportDashboardReportPdf({context:reportContextFixture(),reportId});
    expect(mocks.find).toHaveBeenCalledWith({_id:reportId,tenant:tenantId,creator:creatorId});
    expect(mocks.pdf.mock.calls[0][0].snapshot).toEqual(record.snapshot);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(result.filename).toBe("dashboard-report-2026-11-07.pdf");
  });

  it.each(["tenant","creator"])("rejects a different %s", field=>{
    const record=recordFixture();
    (record as unknown as Record<string,unknown>)[field]="507f1f77bcf86cd799439099";
    expect(()=>assertDashboardReportScope(reportContextFixture(),record)).toThrow();
  });

  it("rejects an export after access to a source branch is revoked", ()=>{
    const context=reportContextFixture();
    context.access.locationAccess.locationIds=[];
    expect(()=>assertDashboardReportScope(context,recordFixture())).toThrow();
  });

  it("rejects a formerly unrestricted report after the user becomes branch-restricted", ()=>{
    const record=recordFixture();record.unrestricted=true;
    expect(()=>assertDashboardReportScope(reportContextFixture(),record)).toThrow();
  });

  it("rejects a report after a source read permission is revoked", ()=>{
    const context=reportContextFixture();
    context.access.permissions=context.access.permissions.filter(permission=>permission!==WORKSPACE_PERMISSION.BOOKINGS_VIEW);
    expect(()=>assertDashboardReportScope(context,recordFixture())).toThrow();
  });

  it("requires reports.export independently from reports.view", async ()=>{
    const context=reportContextFixture();
    context.access.permissions=context.access.permissions.filter(permission=>permission!==WORKSPACE_PERMISSION.REPORTS_EXPORT);
    await expect(exportDashboardReportPdf({context,reportId})).rejects.toMatchObject({statusCode:403});
    expect(mocks.find).not.toHaveBeenCalled();
  });
});
