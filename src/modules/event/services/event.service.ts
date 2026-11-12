import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import {
  assertCurrencyAmountFields,
  resolveFinancialRecordCurrency,
} from "@/shared/money/financial-record.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import Booking from "@/modules/booking/booking.model.js";
import Location from "@/modules/location/location.model.js";
import Order from "@/modules/order/order.model.js";
import User from "@/modules/user/user.model.js";
import mongoose from "mongoose";

import {
  eventRepository,
  type CreateEventPersistenceOptions,
} from "../event.repository.js";
import type { CreateEventInput, ListEventsInput, UpdateEventInput } from "../event.validators.js";

const getTenantCurrency = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);

  return normalizeStudioCommerceCurrency(tenant.settings.currency);
};

const hasMoneyPatch = (input: UpdateEventInput): boolean =>
  input.priceEstimate !== undefined ||
  input.finalPrice !== undefined ||
  input.depositPaid !== undefined;

const validateDeposit = (depositPaid: number, finalPrice: number): void => {
  if (finalPrice > 0 && depositPaid > finalPrice) {
    badRequest("Deposit paid cannot be greater than final price.");
  }
};

const toObjectIds = (values: readonly string[]) =>
  [...new Set(values)].map((value) => new mongoose.Types.ObjectId(value));

const assertTenantEventReferences = async (
  tenantId: string,
  input: Partial<CreateEventInput>,
): Promise<void> => {
  const tenant = new mongoose.Types.ObjectId(tenantId);
  const checks: Promise<void>[] = [];

  const assertReferenceCount = async (
    model: mongoose.Model<any>,
    ids: mongoose.Types.ObjectId[],
    label: string,
  ): Promise<void> => {
    if (!ids.length) return;

    const count = await model.countDocuments({
      _id: { $in: ids },
      tenant,
    });

    if (count !== ids.length) {
      badRequest({
        message: `One or more ${label} do not belong to this workspace.`,
        code: "EVENT_REFERENCE_INVALID",
      });
    }
  };

  if (input.location) {
    checks.push(
      assertReferenceCount(
        Location,
        [new mongoose.Types.ObjectId(input.location)],
        "locations",
      ),
    );
  }

  if (input.assignedStaff !== undefined) {
    checks.push(
      assertReferenceCount(User, toObjectIds(input.assignedStaff), "staff members"),
    );
  }

  if (input.order) {
    checks.push(
      assertReferenceCount(
        Order,
        [new mongoose.Types.ObjectId(input.order)],
        "orders",
      ),
    );
  }

  if (input.bookings !== undefined) {
    checks.push(
      assertReferenceCount(Booking, toObjectIds(input.bookings), "bookings"),
    );
  }

  await Promise.all(checks);
};

export const eventService = {
  async list(
    tenantId: string,
    input: ListEventsInput,
    allowedLocationIds?: readonly string[] | null,
  ) {
    return eventRepository.list({ tenantId, ...input, allowedLocationIds });
  },

  async getById(tenantId: string, eventId: string) {
    const event = await eventRepository.findByIdForTenant(tenantId, eventId);

    if (!event) {
      notFound("Event not found.");
    }

    return event;
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateEventInput,
    options: CreateEventPersistenceOptions = {},
  ) {
    await assertTenantEventReferences(tenantId, input);
    const currency = await getTenantCurrency(tenantId);

    assertCurrencyAmountFields(
      {
        priceEstimate: input.priceEstimate,
        finalPrice: input.finalPrice,
        depositPaid: input.depositPaid,
      },
      currency,
    );

    validateDeposit(input.depositPaid, input.finalPrice);

    return eventRepository.create(
      tenantId,
      createdBy,
      {
        ...input,
        currency,
      },
      options,
    );
  },

  async update(tenantId: string, input: UpdateEventInput) {
    const existing = await eventRepository.findDocumentByIdForTenant(
      tenantId,
      input.id,
    );

    if (!existing) {
      notFound("Event not found.");
    }

    await assertTenantEventReferences(tenantId, input);

    let currencyPatch = {};

    if (hasMoneyPatch(input)) {
      const tenantCurrency = await getTenantCurrency(tenantId);
      const resolution = resolveFinancialRecordCurrency({
        tenantCurrency,
        recordCurrency: existing.currency,
        existingAmounts: [
          Number(existing.priceEstimate || 0),
          Number(existing.finalPrice || 0),
          Number(existing.depositPaid || 0),
        ],
      });

      assertCurrencyAmountFields(
        {
          priceEstimate: input.priceEstimate,
          finalPrice: input.finalPrice,
          depositPaid: input.depositPaid,
        },
        resolution.currency,
      );

      validateDeposit(
        input.depositPaid ?? Number(existing.depositPaid || 0),
        input.finalPrice ?? Number(existing.finalPrice || 0),
      );

      if (resolution.persistSnapshot) {
        currencyPatch = { currency: resolution.currency };
      }
    }

    const event = await eventRepository.update(tenantId, {
      ...input,
      ...currencyPatch,
    });

    if (!event) {
      notFound("Event not found.");
    }

    return event;
  },

  async delete(tenantId: string, eventId: string) {
    const event = await eventRepository.delete(tenantId, eventId);

    if (!event) {
      notFound("Event not found.");
    }

    return { message: "Event deleted." };
  },
};
