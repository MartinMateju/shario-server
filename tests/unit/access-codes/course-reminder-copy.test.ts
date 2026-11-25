import { describe, expect, it } from "vitest";

import { buildCourseReminderCopy } from "@/modules/access-codes/services/course-reminder-copy.js";

const base = {
  courseName: "Wheel basics",
  locationName: "Main studio",
  start: new Date("2027-03-01T17:00:00.000Z"),
  end: new Date("2027-03-01T19:00:00.000Z"),
  timezone: "Europe/London",
};

describe("legacy course reminder copy", () => {
  it("is English for non-Czech studios", () => {
    const copy = buildCourseReminderCopy({ ...base, locale: "en" });

    expect(copy.subject).toBe("Reminder: Wheel basics is coming up");
    expect(copy.textContent).toContain("Wheel basics starts on 01/03/2027");
    expect(copy.textContent).not.toMatch(/Dobrý|připomínáme/);
  });

  it("stays Czech for Czech studios", () => {
    const copy = buildCourseReminderCopy({ ...base, locale: "cs" });

    expect(copy.subject).toBe("Připomínka: Wheel basics už brzy");
    expect(copy.textContent).toContain("Dobrý den");
  });
});
