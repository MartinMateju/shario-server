import mongoose from "mongoose";

import type { EventListFilters } from "./event.types.js";
import { escapeRegex } from "./event.utils.js";

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const buildEventListQuery = (filters: EventListFilters): Record<string, unknown> => {
  const query: Record<string, unknown> = {
    tenant: toObjectId(filters.tenantId),
  };

  if (filters.status) query.status = filters.status;
  if (filters.type) query.type = filters.type;
  if (filters.location) {
    query.location = toObjectId(filters.location);
  } else if (Array.isArray(filters.allowedLocationIds)) {
    query.location = {
      $in: filters.allowedLocationIds.map(toObjectId),
    };
  }

  if (filters.from || filters.to) {
    query.date = {};

    if (filters.from) {
      (query.date as Record<string, Date>).$gte = filters.from;
    }

    if (filters.to) {
      const endDate = new Date(filters.to);
      endDate.setHours(23, 59, 59, 999);
      (query.date as Record<string, Date>).$lte = endDate;
    }
  }

  if (filters.search) {
    const search = escapeRegex(filters.search);

    query.$or = [
      { title: { $regex: search, $options: "i" } },
      { customerName: { $regex: search, $options: "i" } },
      { contactPerson: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};
