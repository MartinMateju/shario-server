import type { CommunicationChannel } from "../communications.constants.js";

export type MatchContact = {
  name?: string;
  email?: string;
  phone?: string;
  whatsappId?: string;
};

export type MatchCustomer = MatchContact & {
  _id?: unknown;
  id?: unknown;
  firstname?: string;
  lastname?: string;
  customId?: string;
};

const normalizeEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();
const normalizePhone = (value: unknown) => String(value ?? "").replace(/[^0-9+]/g, "").replace(/^00/, "+");
const normalizeName = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");

export const normalizeContactIdentity = (
  value: unknown,
  channel: CommunicationChannel | "email" | "whatsapp" | "in_app",
): string => {
  if (channel === "email") return normalizeEmail(value);
  if (channel === "whatsapp") return normalizePhone(value);
  return String(value ?? "").trim();
};

const nameSimilarity = (left: string, right: string): number => {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  const intersection = [...a].filter((part) => b.has(part)).length;
  return intersection / Math.max(a.size, b.size, 1);
};

export const scoreCustomerMatch = (
  contact: MatchContact,
  customer: MatchCustomer,
): { score: number; reasons: string[] } => {
  let score = 0;
  const reasons: string[] = [];
  const contactEmail = normalizeEmail(contact.email);
  const customerEmail = normalizeEmail(customer.email);
  const contactPhone = normalizePhone(contact.phone || contact.whatsappId);
  const customerPhone = normalizePhone(customer.phone || customer.whatsappId);
  const contactName = normalizeName(contact.name);
  const customerName = normalizeName(
    customer.name || [customer.firstname, customer.lastname].filter(Boolean).join(" "),
  );

  if (contactEmail && customerEmail && contactEmail === customerEmail) {
    score += 0.82;
    reasons.push("exact_email");
  }
  if (contactPhone && customerPhone && contactPhone === customerPhone) {
    score += 0.82;
    reasons.push("exact_phone");
  }
  const similarity = nameSimilarity(contactName, customerName);
  if (similarity >= 0.5) {
    score += Math.min(0.18, similarity * 0.18);
    reasons.push(similarity === 1 ? "exact_name" : "similar_name");
  }

  return { score: Math.min(1, Number(score.toFixed(4))), reasons };
};

export const rankCustomerMatches = (
  contact: MatchContact,
  customers: readonly MatchCustomer[],
  limit = 5,
) =>
  customers
    .map((customer) => ({
      customer,
      customerId: String(customer._id ?? customer.id ?? ""),
      ...scoreCustomerMatch(contact, customer),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
