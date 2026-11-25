import type { DashboardManagementOverview } from "./dashboard-management.types.js";
import { dashboardReportSourceLocale } from "./dashboard-report.format.js";

// The source snapshot retains machine-readable coverage. Tenant-facing reports
// retain this wording instead, so the saved screen and PDF explain the same gaps.
const reasons: Record<string, [string, string]> = {
  plan_tier: ["není součástí aktuálního tarifu.", "not included in the current plan."],
  module_disabled: ["příslušná funkce není ve studiu zapnutá.", "the relevant feature is not enabled for this studio."],
  permission_denied: ["nemáte oprávnění zobrazit tyto údaje.", "you do not have permission to view these records."],
  location_attribution_unavailable: ["záznamy nelze spolehlivě přiřadit k vybraným studiím.", "records cannot reliably be assigned to the selected studios."],
  query_limit_exceeded: ["rozsah záznamů překročil limit reportu; neúplný součet se nezobrazuje.", "the record limit was exceeded; a truncated total is not shown."],
  missing_fulfillment_evidence: ["chybí spolehlivé záznamy o poskytnutí služby nebo dodání produktu.", "reliable delivery records are missing."],
};

const sources: Record<string, [string, string]> = {
  bookings: ["Rezervace", "Bookings"], courses: ["Kurzy", "Courses"],
  customers: ["Zákazníci", "Customers"], products: ["Produkty", "Products"],
  sales: ["Prodeje", "Sales"], orders: ["Objednávky", "Orders"],
  orderPayments: ["Přijaté platby", "Payments received"], refunds: ["Vratky", "Refunds"],
  bookingRefunds: ["Vratky rezervací", "Booking refunds"],
  refundLocations: ["Přiřazení vratek ke studiím", "Refund studio attribution"],
  customerHistory: ["Historie zákazníků", "Customer history"],
  customerSpending: ["Útrata zákazníků", "Customer spending"],
  registeredCustomers: ["Registrovaní zákazníci", "Registered customers"],
  customerActivityIdentities: ["Evidence aktivních zákazníků", "Active customer identities"],
  customerBookingActivity: ["Rezervace ateliéru", "Open-studio reservations"],
  customerCourseActivity: ["Rezervace kurzů", "Course reservations"],
  customerCourseActivityLocations: ["Přiřazení kurzových rezervací ke studiím", "Course reservation studio attribution"],
  memberships: ["Členství", "Memberships"], vouchers: ["Vouchery", "Vouchers"],
  voucherSales: ["Prodané vouchery", "Voucher sales"], voucherRedemptions: ["Uplatněné vouchery", "Voucher redemptions"],
  customOrders: ["Zakázky", "Custom orders"], emailIssues: ["E-mailová upozornění", "Email issues"],
  paymentIssues: ["Platební upozornění", "Payment issues"],
  deliveredRevenue: ["Tržby za dodání", "Delivered revenue"],
  recordedPayments: ["Přijaté platby", "Recorded payments"],
  productPurchases: ["Nákupy produktů", "Product purchases"],
  voucherPurchases: ["Nákupy voucherů", "Voucher purchases"],
};

const czechLimitations: Record<string, string> = {
  "Product rankings cover the selected studios only. Voucher purchases are omitted because they cannot be assigned to a studio.":
    "Žebříček produktů zahrnuje pouze vybraná studia. Nákupy voucherů nejsou zahrnuty, protože je nelze přiřadit ke konkrétnímu studiu.",
  "Product rankings exclude voucher purchases because that source is unavailable.":
    "Žebříček produktů nezahrnuje nákupy voucherů, protože tyto údaje nejsou dostupné.",
  "Recorded payments cover the whole workspace by original payment date, net of recorded external refunds. Order payments, voucher purchases and membership invoices count once; later stored-value redemptions do not. They are not proof of service or product delivery.":
    "Přijaté platby zahrnují všechna studia podle data původní platby, po odečtení evidovaných peněžních vratek. Platby objednávek, nákupy voucherů a platby za členství se počítají jednou; pozdější čerpání kreditů či voucherů se znovu nepřičítá. Platba nepotvrzuje poskytnutí služby ani dodání produktu.",
  "Payment totals and spending rankings include only verified dated amounts when payment history is incomplete. Unknown amounts and dates are excluded and no percentage comparison is shown.":
    "Pokud je platební historie neúplná, součty plateb a žebříčky útraty zahrnují pouze doložené částky s datem. Neznámé částky a data se nezapočítávají a procentní srovnání se nezobrazuje.",
  "Product rankings count purchases with verified product quantities and payment dates. Incomplete purchase records are excluded; each product counts once per settled order in the last 30 calendar days.":
    "Žebříček produktů zahrnuje nákupy s doloženým množstvím a datem platby. Neúplné záznamy se nezapočítávají; každý produkt se počítá jednou za zaplacenou objednávku v posledních 30 kalendářních dnech.",
  "Legacy reservations without confirmation timestamps use recorded creation dates; their exact historical confirmation timing cannot be verified.":
    "Starší rezervace bez data potvrzení používají evidované datum vytvoření. Přesný okamžik jejich historického potvrzení nelze ověřit.",
  "Registered customer totals and new customers use customer record creation dates across the workspace; imported records use their recorded creation dates. Workspace totals are unavailable to location-restricted staff.":
    "Celkový počet zákazníků a noví zákazníci vycházejí z dat vytvoření zákaznických záznamů za celou firmu; importované záznamy používají evidované datum vytvoření. Součty za celou firmu nejsou dostupné pracovníkům s přístupem omezeným na vybraná studia.",
  "Active customers are distinct registered customers who created a confirmed reservation in the last 30 calendar days in the selected, authorized studios, regardless of visit date or subscription. Open-studio reservations use booking creation dates; courses use completed reservation order creation dates. Later cancellations still count. Drafts, expired holds, instructors and unnamed guests do not count; staff-added course participants without a dated reservation order cannot be included.":
    "Aktivní zákazníci jsou různí registrovaní zákazníci, kteří v posledních 30 kalendářních dnech vytvořili potvrzenou rezervaci ve vybraných dostupných studiích, bez ohledu na datum návštěvy nebo členství. Open studio používá datum vytvoření rezervace, kurzy datum vytvoření dokončené rezervační objednávky. Pozdější storna se nadále započítávají. Koncepty, vypršelé blokace, lektoři ani hosté bez identity se nepočítají. Účastníky kurzu přidané pracovníkem bez rezervační objednávky s datem nelze zahrnout.",
  "Active subscribers count each customer once while their membership is active or cancellation is scheduled and the current entitlement has not expired. New subscribers use each customer's first recorded membership activation in the selected scope; renewals, plan changes and returning subscribers are not new. Historical active subscriber snapshots are unavailable.":
    "Aktivní předplatitelé počítají každého zákazníka jednou, pokud má aktivní členství nebo naplánované ukončení a jeho současné oprávnění ještě nevypršelo. Noví předplatitelé vycházejí z první evidované aktivace členství zákazníka v daném rozsahu. Prodloužení, změny tarifu a vracející se předplatitelé nejsou noví. Historické stavy aktivních předplatitelů nejsou dostupné.",
  "Customer spending is workspace-wide cash collected for payments dated in the selected period, net of recorded external refunds. Stored-value purchases count once; later redemption does not. Missing payment dates, mixed currencies and unreconstructable historical refunds are unavailable.":
    "Útrata zákazníků zahrnuje přijaté platby za celou firmu s datem v daném období, po odečtení evidovaných peněžních vratek. Nákupy kreditů a voucherů se počítají jednou; jejich pozdější čerpání se znovu nepřičítá. Údaje bez data platby, v různých měnách nebo s nezjistitelnou historií vratek nejsou dostupné.",
  "Memberships without a selected studio are excluded from location-scoped counts.":
    "Členství bez přiřazeného studia nejsou zahrnuta do součtů pro vybraná studia.",
  "Visits and arrival times use elapsed, confirmed scheduled bookings; check-in attendance is not recorded. Removed participants are excluded.":
    "Návštěvnost a časy příchodu vycházejí z uplynulých potvrzených rezervací. Skutečná docházka se neeviduje. Odebraní účastníci nejsou zahrnuti.",
  "New customers means the first recorded elapsed scheduled booking in the selected, authorized studios; unnamed guests cannot be deduplicated.":
    "Noví zákazníci mají ve vybraných dostupných studiích první evidovanou uplynulou rezervaci. Hosty bez jména nelze spolehlivě rozlišit.",
  "Delivered revenue is unavailable: legacy DELIVERED bookings are set automatically after start, and physical products have no fulfillment date. The service subtotal includes only explicit COMPLETED bookings and is not a studio revenue total.":
    "Celkové tržby za dodání nejsou dostupné. Starší rezervace se označují jako poskytnuté automaticky po začátku a u fyzických produktů chybí datum dodání. Doložená část služeb zahrnuje pouze výslovně dokončené rezervace a není celkovou tržbou studia.",
  "The service subtotal excludes lines with missing financial/location snapshots, membership-credit redemptions, discounts without allocation, or refund corrections.":
    "Doložená část služeb nezahrnuje položky bez úplných finančních údajů či přiřazení studia, platby členskými kredity, nerozdělené slevy ani opravy vratek.",
  "Previous active membership counts are unavailable because historical pause/status snapshots are not recorded. New and cancelled memberships use their recorded event dates.":
    "Dřívější počty aktivních členství nejsou dostupné, protože chybí historie jejich stavů a pozastavení. Nová a ukončená členství vycházejí z evidovaných dat změn.",
  "Cash receipts include only order Stripe/manual payment allocations. Membership invoices, voucher purchases and legacy allocations are excluded. Refunds include recorded card refunds for bookings in this report scope; other refund channels are excluded. These are partial cash figures, separate from delivered revenue.":
    "Přijaté platby zahrnují pouze platby objednávek přes Stripe a ručně evidované platby. Nezahrnují faktury za členství, nákupy voucherů ani starší nerozdělené platby. Vratky zahrnují pouze evidované karetní vratky rezervací v tomto reportu. Jde o neúplné peněžní údaje, oddělené od tržeb za dodání.",
  "Voucher sales use payment date and exclude shipping. Redemptions count committed checkout transactions before later reversals; wallet conversions and legacy unrecorded redemptions are excluded. Sales are not delivered revenue.":
    "Prodané vouchery vycházejí z data platby a nezahrnují dopravu. Uplatnění počítá dokončené transakce před případným pozdějším stornem. Převody do peněženky a starší neevidovaná uplatnění nejsou zahrnuta. Prodej voucherů není tržbou za dodání.",
  "Active custom orders and attention issues show the current state at generation time, independently of the selected comparison periods.":
    "Aktivní zakázky a provozní upozornění zobrazují stav při vytvoření reportu nezávisle na vybraných srovnávaných obdobích.",
};

export const dashboardReportLimitations = (snapshot: DashboardManagementOverview, locale: string): string[] => {
  const index = dashboardReportSourceLocale(locale) === "cs" ? 0 : 1;
  const limitations = snapshot.coverage.limitations.map(value => index === 0 ? czechLimitations[value] ?? value : value);
  for (const entry of snapshot.coverage.unavailable) {
    const source = sources[entry.source]?.[index] ?? ["Některé údaje", "Some data"][index];
    const reason = reasons[entry.reason]?.[index] ?? ["chybí dostatečné podklady pro report.", "sufficient reporting records are unavailable."][index];
    limitations.push(`${source}: ${reason}`);
  }
  return [...new Set(limitations)];
};
