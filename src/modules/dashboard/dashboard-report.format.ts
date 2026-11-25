import { getCurrencyExponent, normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";

import type { DashboardManagementOverview } from "./dashboard-management.types.js";
import type { DashboardReportSection } from "./dashboard-report.types.js";

export const dashboardReportSourceLocale = (locale: string): "cs" | "en" =>
  locale.startsWith("cs") ? "cs" : "en";

/** Server-produced wording is retained in the snapshot, including unavailable data. */
export const buildDashboardReportSections = (
  snapshot: DashboardManagementOverview,
  locale: string,
): DashboardReportSection[] => {
  const cs = dashboardReportSourceLocale(locale) === "cs";
  const copy = (czech: string, english: string) => cs ? czech : english;
  const recordedPayments = snapshot.metadata.revenueBasis === "recorded_net_payments";
  const unavailable = copy("Nedostupné", "Unavailable");
  const currency = normalizeStudioCommerceCurrency(snapshot.metadata.currency);
  const number = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(cs ? "cs-CZ" : "en-GB", { maximumFractionDigits: 2 }).format(value)
      : unavailable;
  const money = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(cs ? "cs-CZ" : "en-GB", {
        style: "currency", currency,
        minimumFractionDigits: getCurrencyExponent(currency),
        maximumFractionDigits: getCurrencyExponent(currency),
      }).format(value / 10 ** getCurrencyExponent(currency))
      : unavailable;
  const period = (value: { from: string; to: string }) => `${value.from} - ${value.to}`;
  const columns: [string, string, string] = [
    copy("Ukazatel", "Metric"),
    period(snapshot.metadata.period),
    period(snapshot.metadata.comparisonPeriod),
  ];
  const kpi = (
    label: string,
    value: { value: number | null; previous: number | null } | undefined,
    monetary = false,
  ) => ({ label, value: (monetary ? money : number)(value?.value), previous: (monetary ? money : number)(value?.previous) });
  const sections: DashboardReportSection[] = [
    {
      key: "revenue", title: recordedPayments
        ? copy("Přijaté platby - všechna studia", "Recorded payments - whole workspace")
        : copy("Tržby za poskytnuté služby a dodané produkty", "Revenue from delivered services and products"), columns,
      rows: [kpi(recordedPayments ? copy("Přijaté platby po vratkách", "Recorded payments after refunds") : copy("Tržby za období", "Delivered revenue"), recordedPayments ? snapshot.summary.recordedPaymentsMinor : snapshot.summary.deliveredRevenueMinor, true)],
      notes: [recordedPayments
        ? copy("Platby za objednávky, vouchery a členství za všechna studia podle data platby, po odečtení evidovaných peněžních vratek. Čerpání kreditů a voucherů se znovu nepřičítá. Vratky jsou přiřazeny k původní platbě; nejde o peněžní tok podle data vratky ani o potvrzení dodání.", "Order, voucher and membership payments across all studios by payment date, less recorded external refunds. Credit and voucher redemption is not counted again. Refunds are attributed to the original payment; this is not cash flow by refund date or evidence of delivery.")
        : copy("Rozhoduje poskytnutí služby nebo dodání produktu, nikoli datum platby. Neúplná evidence neznamená nulové tržby.", "Revenue follows service provision or product delivery, not payment dates. Incomplete records do not mean zero revenue.")],
    },
    {
      key: "cash", title: snapshot.cash.complete
        ? copy("Přijaté platby a vratky", "Payments received and refunds")
        : copy("Doložené platby a vratky (neúplné)", "Documented payments and refunds (partial)"), columns,
      rows: [
        kpi(copy("Přijaté platby", "Payments received"), snapshot.cash.receivedMinor, true),
        kpi(copy("Vyplacené vratky", "Refunds paid"), snapshot.cash.refundsMinor, true),
        kpi(copy("Počet vratek", "Refund transactions"), snapshot.cash.refundCount),
        kpi(copy("Přijato po vratkách", "Net cash received"), snapshot.cash.netReceivedMinor, true),
      ],
      notes: [copy("Podle data peněžního pohybu. Tyto částky se nepřičítají k tržbám; vratky se automaticky znovu neodečítají od tržeb za jiné období.", "Based on cash movement dates. Do not add these figures to revenue or automatically deduct refunds again from revenue for another period.")],
    },
    {
      key: "customers", title: copy("Návštěvnost a zákazníci", "Attendance and customers"), columns,
      rows: [
        kpi(snapshot.attendance.source === "recorded" ? copy("Zaznamenané návštěvy", "Recorded visits") : copy("Uplynulé rezervované návštěvy", "Elapsed booked visits"), snapshot.summary.visits),
        kpi(copy("Open studio", "Open studio"), snapshot.attendance.openStudio),
        kpi(copy("Kurzy", "Courses"), snapshot.attendance.courses),
        kpi(copy("Různí zákazníci", "Unique customers"), snapshot.summary.uniqueCustomers),
        kpi(copy("Zákazníci s první evidovanou rezervací", "Customers with their first recorded booking"), snapshot.summary.newCustomers),
      ],
      notes: [snapshot.attendance.source === "recorded"
        ? copy("Návštěvy vycházejí ze zaznamenané docházky. Jeden zákazník může přijít vícekrát.", "Visits use recorded attendance. A customer may visit more than once.")
        : copy("Docházka není potvrzena. Uplynulé rezervace nejsou důkazem skutečné návštěvy; hodinový graf vychází z časů rezervací." , "Attendance is not confirmed. Elapsed bookings do not prove visits; the hourly pattern uses booking times."),
        copy("První rezervace se posuzuje podle dostupné historie ve vybraných studiích. Nejde o datum registrace ani o potvrzenou první návštěvu.", "First bookings use the available history within the selected studios, not registration dates or verified first visits.")],
    },
    {
      key: "memberships", title: copy("Členství", "Memberships"), columns,
      rows: [
        kpi(snapshot.memberships.newSubscribers
          ? copy("Aktivní předplatitelé - dostupný stav", "Active subscribers - available snapshot")
          : copy("Aktivní členství - dostupný stav", "Active memberships - available snapshot"), snapshot.summary.activeMemberships),
        ...(snapshot.memberships.newSubscribers ? [kpi(copy("Noví předplatitelé za období", "New subscribers during period"), snapshot.memberships.newSubscribers)] : []),
        kpi(copy("Nová členství", "New memberships"), snapshot.memberships.new),
        kpi(copy("Ukončená členství", "Cancelled memberships"), snapshot.memberships.cancelled),
      ],
      notes: [copy("Aktivní stav odpovídá okamžiku vytvoření reportu; historický stav se bez průkazné evidence nezobrazuje. Nová a ukončená členství jsou změny během období.", "The active snapshot reflects the time this report was generated; historical totals are unavailable without reliable history. New and cancelled memberships are events within the period."),
        ...(snapshot.memberships.newSubscribers ? [
          copy("Předplatitelé jsou různí zákazníci, každý se počítá jednou. Nový předplatitel má v období první evidovanou aktivaci členství v daném rozsahu; prodloužení, změna tarifu ani obnovení dřívějšího členství se nepočítají jako nový předplatitel. Noví předplatitelé nejsou čistým přírůstkem aktivních předplatitelů.", "Subscribers are unique customers, counted once each. New subscribers have their first recorded membership activation within the scope during the period; renewals, plan changes and reactivations do not count as new subscribers. New subscribers are not net growth in active subscribers."),
          snapshot.memberships.scope === "workspace"
            ? copy("Počty předplatitelů zahrnují celou firmu.", "Subscriber counts cover the whole workspace.")
            : copy("Počty předplatitelů zahrnují členství platná ve vybraných studiích včetně sdílených členství. Každý zákazník se počítá jednou.", "Subscriber counts include memberships valid in the selected studios, including shared memberships. Each customer counts once."),
        ] : [])],
    },
    {
      key: "vouchers", title: copy("Vouchery", "Vouchers"), columns,
      rows: [
        kpi(copy("Prodané vouchery", "Vouchers sold"), snapshot.vouchers.sold),
        kpi(copy("Hodnota prodaných voucherů", "Value of vouchers sold"), snapshot.vouchers.soldValueMinor, true),
        kpi(copy("Uplatněné vouchery", "Vouchers redeemed"), snapshot.vouchers.redeemed),
        kpi(copy("Uplatněná hodnota", "Redeemed value"), snapshot.vouchers.redeemedValueMinor, true),
      ],
      notes: [copy("Prodej voucheru je sledován odděleně od tržeb za dodání. Uplatnění na budoucí rezervaci ještě není poskytnutím služby.", "Voucher sales are separate from delivered revenue. Redemption against a future booking does not yet deliver a service.")],
    },
    {
      key: "orders", title: copy("Zakázky a termíny", "Custom orders and deadlines"),
      columns: [copy("Zakázka", "Order"), copy("Stav", "Status"), copy("Termín", "Deadline")],
      rows: [
        { label: copy("Aktivní zakázky", "Active orders"), value: number(snapshot.orders.activeCount) },
        { label: copy("Zakázky po termínu", "Overdue orders"), value: number(snapshot.orders.overdueCount) },
        ...snapshot.orders.items.map(order => ({ label: `${order.reference || order.id}: ${order.title}`, value: order.status === "active" ? copy("Aktivní", "Active") : order.status, previous: order.deadline?.slice(0, 10) || "-" })),
      ], notes: [copy("Zakázky zobrazují stav při vytvoření reportu. Tento stav se nevztahuje ke konci srovnávaných období.", "Orders reflect the state when this report was generated, independently of the comparison periods.")],
    },
    {
      key: "issues", title: copy("Provozní upozornění", "Operational attention"),
      columns: [copy("Oblast", "Issue"), copy("Počet", "Count"), copy("Částka", "Amount")],
      rows: snapshot.issues.map(issue => ({ label: dashboardReportIssueLabel(issue.key, locale), value: number(issue.count), previous: issue.amountMinor == null ? "-" : money(issue.amountMinor) })),
      notes: snapshot.issues.length ? [] : [copy("V dostupných zdrojích nejsou evidována upozornění.", "No attention items were found in the available sources.")],
    },
  ];
  if (recordedPayments && snapshot.summary.recordedPaymentsComplete === false) {
    sections[0].notes.push(copy(
      "Zobrazen je pouze součet doložených plateb. Některé záznamy nemají úplné údaje o částce nebo datu a nelze je zahrnout. Procentní změna se při neúplných údajích neuvádí.",
      "Only verified payment amounts are included. Some records have incomplete amounts or dates and cannot be included. Percentage change is not shown when records are incomplete.",
    ));
  }
  if (snapshot.customers) {
    const customerSections: DashboardReportSection[] = [{
      key: "registeredCustomers", title: copy("Registrovaní zákazníci - celá firma", "Registered customers - whole workspace"), columns,
      rows: [
        kpi(copy("Celkem zákazníků ke konci období", "Total customers at period cutoff"), snapshot.customers.total),
        kpi(copy("Nově registrovaní za období", "Newly registered during period"), snapshot.customers.new),
      ],
      notes: [copy("Počítají se zákaznické záznamy podle data vytvoření za celou firmu, nezávisle na vybraném studiu. První rezervace není registrace. Nedostupné údaje se nezobrazují jako nula.", "Customer records are counted by creation date across the whole workspace, independently of the selected studio. A first booking is not a registration. Unavailable values are not shown as zero.")],
    }];
    const activePeriod = snapshot.metadata.activeCustomerPeriod;
    const activeComparison = snapshot.metadata.activeCustomerComparisonPeriod;
    customerSections.push({
      key: "activeCustomers", title: copy("Aktivní zákazníci - posledních 30 dní", "Active customers - last 30 days"),
      columns: [columns[0], activePeriod ? period(activePeriod) : unavailable, activeComparison ? period(activeComparison) : unavailable],
      rows: [kpi(copy("Zákazníci, kteří vytvořili rezervaci", "Customers who created a booking"), snapshot.customers.activeLast30Days)],
      notes: [
        copy("Každý zákazník se počítá jednou, pokud v uvedených 30 dnech vytvořil alespoň jednu potvrzenou rezervaci. Rozhoduje datum vytvoření rezervace, nikoli datum návštěvy; návštěva může být v budoucnu. U kurzů se používá datum vytvoření dokončené rezervační objednávky. Pozdější storno se nadále započítává. Členství není podmínkou aktivity.", "Each customer counts once if they created at least one confirmed booking in the stated 30-day window. The booking creation date determines activity, not the visit date; the visit may be in the future. Courses use the creation date of a completed reservation order. Later cancellation still counts. A subscription is not required for activity."),
        snapshot.customers.activeScope === "workspace"
          ? copy("Aktivita zahrnuje celou firmu.", "Activity covers the whole workspace.")
          : copy("Aktivita zahrnuje rezervace ve vybraných studiích.", "Activity covers bookings in the selected studios."),
        copy("Celkový počet zákazníků, noví zákazníci, aktivní zákazníci a předplatitelé se mohou překrývat; nesčítají se. Aktivita má vlastní období 30 dní, ostatní přírůstky používají období měsíčního reportu.", "Total customers, new customers, active customers and subscribers may overlap; do not add them together. Activity has its own 30-day period, while other additions use the monthly report period."),
      ],
    });
    const membershipIndex = sections.findIndex(section => section.key === "memberships");
    sections.splice(membershipIndex, 0, ...customerSections);
  }
  // Confirmed components must never masquerade as a complete revenue total.
  const breakdown = snapshot.revenueBreakdown;
  if (breakdown && !recordedPayments) {
    const confirmed = breakdown.confirmedServicesMinor;
    if (confirmed) sections[0].rows.push(kpi(copy("Doložená část tržeb ze služeb (neúplná)", "Documented service revenue (partial)"), confirmed, true));
  }
  return sections;
};

export const dashboardReportIssueLabel = (key: string, locale: string): string => {
  const labels: Record<string, [string, string]> = {
    failedEmails: ["Nedoručené e-maily", "Failed emails"],
    overduePayments: ["Platby po splatnosti", "Overdue payments"],
    overdueOrders: ["Zakázky po termínu", "Overdue custom orders"],
    overdueTasks: ["Úkoly po termínu", "Overdue tasks"],
    failed_emails: ["Nedoručené e-maily", "Failed emails"],
    overdue_invoices: ["Faktury po splatnosti", "Overdue invoices"],
    overdue_custom_orders: ["Zakázky po termínu", "Overdue custom orders"],
  };
  return labels[key]?.[dashboardReportSourceLocale(locale) === "cs" ? 0 : 1] ?? key;
};
