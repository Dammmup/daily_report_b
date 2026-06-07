export const businessTimeZone = process.env.BUSINESS_TIME_ZONE || "Asia/Almaty";

function businessParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: values.get("year") || "1970",
    month: values.get("month") || "01",
    day: values.get("day") || "01",
    hour: Number(values.get("hour") || 0),
    minute: Number(values.get("minute") || 0)
  };
}

export function businessDateIso(date = new Date()) {
  const parts = businessParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function businessTime(date = new Date()) {
  const parts = businessParts(date);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function businessHour(date = new Date()) {
  return businessParts(date).hour;
}

export function businessWeekday(date = new Date()) {
  return new Date(`${businessDateIso(date)}T00:00:00.000Z`).getUTCDay();
}

export function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function businessDateTime(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guess = new Date(localAsUtc);
  const guessParts = businessParts(guess);
  const guessAsUtc = Date.UTC(
    Number(guessParts.year),
    Number(guessParts.month) - 1,
    Number(guessParts.day),
    guessParts.hour,
    guessParts.minute
  );
  return new Date(localAsUtc - (guessAsUtc - guess.getTime()));
}

export function businessWeekStartIso(date = new Date()) {
  const weekday = businessWeekday(date) || 7;
  return addIsoDays(businessDateIso(date), 1 - weekday);
}

export function isSameBusinessDay(left?: Date | null, right = new Date()) {
  return Boolean(left && businessDateIso(left) === businessDateIso(right));
}
