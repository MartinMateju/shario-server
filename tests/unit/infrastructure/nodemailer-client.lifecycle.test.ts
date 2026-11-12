import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  firstClose: vi.fn(),
  secondClose: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

import {
  closeEmailTransporter,
  getEmailTransporter,
} from "@/infrastructure/email/nodemailer.client.js";

describe("default email transporter lifecycle", () => {
  beforeEach(() => {
    closeEmailTransporter();
    vi.clearAllMocks();
    process.env.EMAIL_USER = "system@example.test";
    process.env.EMAIL_PASSWORD = "secret";
    mocks.createTransport
      .mockReturnValueOnce({ close: mocks.firstClose })
      .mockReturnValueOnce({ close: mocks.secondClose });
  });

  it("closes and clears the cached transporter so a later send gets a fresh connection", () => {
    const first = getEmailTransporter();
    expect(getEmailTransporter()).toBe(first);
    expect(mocks.createTransport).toHaveBeenCalledOnce();

    closeEmailTransporter();
    expect(mocks.firstClose).toHaveBeenCalledOnce();

    const second = getEmailTransporter();
    expect(second).not.toBe(first);
    expect(mocks.createTransport).toHaveBeenCalledTimes(2);

    closeEmailTransporter();
    closeEmailTransporter();
    expect(mocks.secondClose).toHaveBeenCalledOnce();
  });
});
