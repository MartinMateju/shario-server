import { badRequest } from "../../shared/http/httpErrors.js";

export const requirePositiveNumber = (
  value: unknown,
  fieldName: string,
): number => {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    badRequest(`${fieldName} must be a valid positive number.`);
  }

  return number;
};

export const requirePositiveInteger = (
  value: unknown,
  fieldName: string,
): number => {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    badRequest(`${fieldName} must be a valid positive integer.`);
  }

  return number;
};

export const requireString = (value: unknown, fieldName: string): string => {
  const stringValue = String(value || "").trim();

  if (!stringValue) {
    badRequest(`${fieldName} is required.`);
  }

  return stringValue;
};
