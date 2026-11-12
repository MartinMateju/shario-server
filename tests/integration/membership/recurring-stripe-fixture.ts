import Stripe from "stripe";

export const TEST_STRIPE_KEY = "sk_test_membership_http_no_external_requests";
export const TEST_ACCOUNT = "acct_membership_http_fixture";
export const TEST_WEBHOOK_SECRET = "whsec_membership_http_fixture";

/** Real Stripe SDK, fake network only. No request can reach Stripe. */
export class RecurringStripeFixture {
  requests: {
    method: string;
    path: string;
    body: URLSearchParams;
    headers: Record<string, string>;
  }[] = [];
  checkout: any;
  subscription: any;
  completeDuringExpiration = false;
  invoices = new Map<string, any>();
  prices = new Map<string, any>();
  schedules = new Map<string, any>();
  scheduleUpdateResponsesToDrop = 0;
  scheduleUpdateRequestsToReject = 0;
  priceRequestsToReject = 0;
  private idempotentResponses = new Map<string, any>();
  private restore?: () => void;

  install() {
    const prototype = Object.getPrototypeOf(Stripe.createNodeHttpClient());
    const original = prototype.makeRequest;
    prototype.makeRequest = async (
      host,
      port,
      path,
      method,
      headers,
      data,
      protocol,
    ) => {
      const normalized = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [
          key.toLowerCase(),
          String(value),
        ]),
      );
      if (
        process.env.NODE_ENV !== "test" ||
        process.env.STRIPE_KEY !== TEST_STRIPE_KEY ||
        host !== "api.stripe.com" ||
        String(port) !== "443" ||
        protocol !== "https" ||
        normalized.authorization !== `Bearer ${TEST_STRIPE_KEY}`
      ) {
        throw new Error(
          "External Stripe traffic blocked by membership fixture.",
        );
      }
      const route = path.split("?")[0];
      if (
        route !== `/v1/accounts/${TEST_ACCOUNT}` &&
        normalized["stripe-account"] !== TEST_ACCOUNT
      ) {
        throw new Error(
          "Membership Stripe request missing the fixture connected account.",
        );
      }
      const body = new URLSearchParams(data);
      this.requests.push({ method, path, body, headers: normalized });
      if (method === "POST" && /^\/v1\/subscription_schedules\/[^/]+$/.test(route) && this.scheduleUpdateRequestsToReject > 0) {
        this.scheduleUpdateRequestsToReject -= 1;
        throw new Error("Fixture network outage before schedule configuration.");
      }
      if (method === "POST" && route === "/v1/prices" && this.priceRequestsToReject > 0) {
        this.priceRequestsToReject -= 1;
        throw new Error("Fixture network outage before price creation.");
      }
      let value: any;
      const idempotencyKey = normalized["idempotency-key"];
      const replayKey = idempotencyKey ? `${method}:${route}:${idempotencyKey}` : null;
      const metadataFrom = (prefix: string) => Object.fromEntries(
        [...body].filter(([key]) => key.startsWith(`${prefix}[`))
          .map(([key, entry]) => [key.slice(prefix.length + 1, -1), entry]),
      );
      if (replayKey && this.idempotentResponses.has(replayKey)) {
        value = this.idempotentResponses.get(replayKey);
      } else if (method === "GET" && route === `/v1/accounts/${TEST_ACCOUNT}`) {
        value = {
          id: TEST_ACCOUNT,
          object: "account",
          country: "CZ",
          default_currency: "czk",
          livemode: false,
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          controller: {
            fees: { payer: "account" },
            losses: { payments: "stripe" },
            requirement_collection: "stripe",
            stripe_dashboard: { type: "full" },
          },
          requirements: {
            currently_due: [],
            eventually_due: [],
            past_due: [],
            pending_verification: [],
            disabled_reason: null,
          },
        };
      } else if (method === "POST" && route === "/v1/checkout/sessions") {
        const metadata = Object.fromEntries(
          [...body]
            .filter(([key]) => /^metadata\[/.test(key))
            .map(([key, value]) => [key.slice(9, -1), value]),
        );
        this.checkout = {
          id: "cs_test_membership_http",
          object: "checkout.session",
          mode: "subscription",
          status: "open",
          payment_status: "unpaid",
          created: Math.floor(Date.now() / 1000),
          expires_at: Number(body.get("expires_at")),
          url: "https://checkout.stripe.test/membership",
          metadata,
          client_reference_id: body.get("client_reference_id"),
          subscription: null,
          invoice: null,
          customer: null,
          currency: "czk",
          amount_total: Number(
            body.get("line_items[0][price_data][unit_amount]"),
          ),
          livemode: false,
        };
        this.prices.set("price_membership_original", {
          id: "price_membership_original", object: "price", active: true,
          currency: body.get("line_items[0][price_data][currency]"),
          unit_amount: this.checkout.amount_total, type: "recurring",
          product: "prod_membership_original",
          recurring: {
            interval: body.get("line_items[0][price_data][recurring][interval]"),
            interval_count: Number(body.get("line_items[0][price_data][recurring][interval_count]") || 1),
            usage_type: "licensed",
          },
          metadata,
        });
        value = this.checkout;
      } else if (method === "GET" && route === "/v1/checkout/sessions") {
        value = {
          object: "list",
          data: this.checkout ? [this.checkout] : [],
          has_more: false,
          url: route,
        };
      } else if (
        method === "GET" &&
        route === `/v1/checkout/sessions/${this.checkout?.id}`
      ) {
        value = this.checkout;
      } else if (
        method === "POST" &&
        route === `/v1/checkout/sessions/${this.checkout?.id}/expire`
      ) {
        if (this.completeDuringExpiration) {
          this.checkout.status = "complete";
          this.checkout.payment_status = "paid";
        }
        if (this.checkout.status !== "open")
          throw new Error("Checkout is already complete.");
        this.checkout.status = "expired";
        value = this.checkout;
      } else if (route === `/v1/subscriptions/${this.subscription?.id}`) {
        if (method === "POST")
          this.subscription.cancel_at_period_end =
            body.get("cancel_at_period_end") === "true";
        else if (method === "DELETE") this.subscription.status = "canceled";
        else if (method !== "GET")
          throw new Error("Unexpected subscription operation.");
        value = this.subscription;
      } else if (method === "POST" && route === "/v1/prices") {
        value = {
          id: `price_membership_change_${this.prices.size}`,
          object: "price", active: true, type: "recurring",
          currency: body.get("currency"), unit_amount: Number(body.get("unit_amount")),
          product: body.get("product") || `prod_membership_change_${this.prices.size}`,
          recurring: {
            interval: body.get("recurring[interval]"),
            interval_count: Number(body.get("recurring[interval_count]") || 1),
            usage_type: "licensed",
          },
          metadata: metadataFrom("metadata"),
        };
        this.prices.set(value.id, value);
      } else if (method === "POST" && route === "/v1/subscription_schedules") {
        if (body.get("from_subscription") !== this.subscription?.id || this.subscription.schedule)
          throw new Error("Fixture schedules must adopt the single existing unscheduled subscription.");
        value = {
          id: `sub_sched_membership_${this.schedules.size + 1}`,
          object: "subscription_schedule", status: "active", end_behavior: "release",
          subscription: this.subscription.id, customer: this.subscription.customer,
          metadata: metadataFrom("metadata"), default_settings: {},
          current_phase: {
            start_date: this.subscription.current_period_start,
            end_date: this.subscription.current_period_end,
          },
          phases: [{
            start_date: this.subscription.current_period_start,
            end_date: this.subscription.current_period_end,
            items: [{ price: this.subscription.items.data[0].price.id, quantity: 1 }],
            metadata: { ...this.subscription.metadata }, proration_behavior: "none",
          }],
          released_subscription: null,
        };
        this.subscription.schedule = value.id;
        this.schedules.set(value.id, value);
      } else if (route.startsWith("/v1/subscription_schedules/")) {
        const [scheduleId, action] = route.slice("/v1/subscription_schedules/".length).split("/");
        value = this.schedules.get(scheduleId);
        if (!value) throw new Error("Unknown fixture schedule.");
        if (method === "POST" && action === "release") {
          value.status = "released";
          value.released_subscription = value.subscription;
          value.subscription = null;
          value.released_at = Math.floor(Date.now() / 1000);
          this.subscription.schedule = null;
        } else if (method === "POST" && !action) {
          if (body.has("end_behavior")) value.end_behavior = body.get("end_behavior");
          value.metadata = { ...value.metadata, ...metadataFrom("metadata") };
          if (body.has("phases[0][items][0][price]")) {
            value.phases = [0, 1].filter((index) => body.has(`phases[${index}][items][0][price]`))
              .map((index) => {
                const prefix = `phases[${index}]`;
                const start = Number(body.get(`${prefix}[start_date]`) || value.phases[index - 1]?.end_date);
                const iterations = Number(body.get(`${prefix}[iterations]`) || 1);
                const end = new Date(start * 1000);
                end.setUTCMonth(end.getUTCMonth() + iterations);
                return {
                  start_date: start,
                  end_date: Number(body.get(`${prefix}[end_date]`) || end.getTime() / 1000),
                  items: [{ price: body.get(`${prefix}[items][0][price]`),
                    quantity: Number(body.get(`${prefix}[items][0][quantity]`) || 1) }],
                  metadata: metadataFrom(`${prefix}[metadata]`),
                  proration_behavior: body.get(`${prefix}[proration_behavior]`),
                };
              });
            value.current_phase = {
              start_date: value.phases[0].start_date, end_date: value.phases[0].end_date,
            };
          }
        } else if (method !== "GET") throw new Error("Unexpected schedule operation.");
      } else if (method === "GET" && route.startsWith("/v1/invoices/")) {
        value = this.invoices.get(route.slice("/v1/invoices/".length));
      } else if (method === "GET" && route === "/v1/invoices") {
        value = {
          object: "list",
          data: [...this.invoices.values()],
          has_more: false,
          url: "/v1/invoices",
        };
      }
      if (!value)
        throw new Error(
          `Unconfigured Stripe fixture request: ${method} ${route}`,
        );
      if (replayKey) this.idempotentResponses.set(replayKey, structuredClone(value));
      if (method === "POST" && /^\/v1\/subscription_schedules\/[^/]+$/.test(route) && this.scheduleUpdateResponsesToDrop > 0) {
        this.scheduleUpdateResponsesToDrop -= 1;
        throw new Error("Simulated network loss after Stripe applied schedule update.");
      }
      const responseHeaders = {
        "content-type": "application/json",
        "request-id": "req_membership_fixture",
      };
      return {
        getStatusCode: () => 200,
        getHeaders: () => responseHeaders,
        getRawResponse: () => ({ statusCode: 200, headers: responseHeaders }),
        toJSON: async () => structuredClone(value),
        toStream: () => {
          throw new Error("No fixture streams.");
        },
      };
    };
    this.restore = () => {
      prototype.makeRequest = original;
    };
  }

  uninstall() {
    this.restore?.();
  }
  reset() {
    this.requests = [];
    this.checkout = null;
    this.subscription = null;
    this.completeDuringExpiration = false;
    this.invoices.clear();
    this.prices.clear();
    this.schedules.clear();
    this.scheduleUpdateResponsesToDrop = 0;
    this.scheduleUpdateRequestsToReject = 0;
    this.priceRequestsToReject = 0;
    this.idempotentResponses.clear();
  }

  period(start: Date, end: Date, paid = true) {
    const invoiceId = `in_membership_${start.getUTCMonth() + 1}`;
    const schedule = this.schedules.get(this.subscription?.schedule);
    const phase = schedule?.status === "active"
      ? schedule.phases.find((item) => item.start_date <= start.getTime() / 1000 && item.end_date > start.getTime() / 1000)
      : null;
    const price = this.prices.get(phase?.items[0]?.price)
      ?? this.subscription?.items?.data[0]?.price
      ?? this.prices.get("price_membership_original");
    const metadata = { ...(this.subscription?.metadata ?? this.checkout.metadata), ...(phase?.metadata ?? {}) };
    if (phase) schedule.current_phase = { start_date: phase.start_date, end_date: phase.end_date };
    if (schedule?.status === "active" && start.getTime() / 1000 >= schedule.phases.at(-1).end_date) {
      schedule.status = "released";
      schedule.released_subscription = this.subscription.id;
      schedule.subscription = null;
    }
    this.subscription = {
      id: "sub_membership_http",
      object: "subscription",
      customer: "cus_membership_http",
      status: paid ? "active" : "past_due",
      cancel_at_period_end: false,
      current_period_start: start.getTime() / 1000,
      current_period_end: end.getTime() / 1000,
      metadata,
      schedule: schedule?.status === "active" ? schedule.id : null,
      items: { object: "list", data: [{ id: "si_membership_http", object: "subscription_item", quantity: 1, price }] },
      currency: price.currency,
      collection_method: "charge_automatically",
      cancel_at: null, canceled_at: null, pause_collection: null, pending_update: null,
      discount: null, default_tax_rates: [], automatic_tax: { enabled: false },
      latest_invoice: invoiceId,
      livemode: false,
    };
    const invoice = {
      id: invoiceId,
      object: "invoice",
      subscription: this.subscription.id,
      customer: this.subscription.customer,
      status: paid ? "paid" : "open",
      currency: price.currency,
      total: price.unit_amount,
      amount_paid: paid ? price.unit_amount : 0,
      amount_due: paid ? 0 : price.unit_amount,
      subscription_details: { metadata },
      created: Math.floor(Date.now() / 1000),
      status_transitions: {
        paid_at: paid ? Math.floor(Date.now() / 1000) : null,
      },
      number: `MEMBER-${invoiceId}`,
      hosted_invoice_url: "",
      invoice_pdf: "",
      lines: {
        data: [
          {
            id: `il_${invoiceId}`,
            type: "subscription",
            subscription: this.subscription.id,
            proration: false,
            price, quantity: 1, amount: price.unit_amount, currency: price.currency,
            period: {
              start: start.getTime() / 1000,
              end: end.getTime() / 1000,
            },
          },
        ],
      },
      livemode: false,
    };
    this.invoices.set(invoiceId, invoice);
    this.checkout.subscription = this.subscription.id;
    this.checkout.customer = this.subscription.customer;
    if (!this.checkout.invoice) this.checkout.invoice = invoiceId;
    return invoice;
  }
}
