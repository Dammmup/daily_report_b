type CronAuthorizationInput = {
  secret?: string;
  authorization?: string;
  cronHeader?: string;
};

export function cronAuthorizationStatus(input: CronAuthorizationInput) {
  const secret = input.secret?.trim();
  if (!secret || secret.length < 16 || secret === "change-this-cron-secret") return "unconfigured" as const;
  if (input.authorization !== `Bearer ${secret}` && input.cronHeader !== secret) return "unauthorized" as const;
  return "authorized" as const;
}
