import assert from "node:assert/strict";
import test from "node:test";
import { businessDateIso, businessDateTime, businessTime, businessWeekStartIso } from "./date.js";

test("businessDateIso uses Asia/Almaty instead of UTC", () => {
  const lateUtcEvening = new Date("2026-06-06T19:30:00.000Z");
  assert.equal(businessDateIso(lateUtcEvening), "2026-06-07");
  assert.equal(businessTime(lateUtcEvening), "00:30");
});

test("businessWeekStartIso starts on Monday in the business timezone", () => {
  assert.equal(businessWeekStartIso(new Date("2026-06-07T06:00:00.000Z")), "2026-06-01");
  assert.equal(businessWeekStartIso(new Date("2026-06-08T05:00:00.000Z")), "2026-06-08");
});

test("businessDateTime converts an Almaty wall-clock time to UTC", () => {
  assert.equal(businessDateTime("2026-06-07", "10:15").toISOString(), "2026-06-07T05:15:00.000Z");
});
