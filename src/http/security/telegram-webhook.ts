import crypto from "node:crypto";

type WebhookAuthorizationInput = {
  secret?: string;
  headerToken?: string;
};

/**
 * Telegram sends the configured secret in the `X-Telegram-Bot-Api-Secret-Token`
 * header on every webhook call. We verify it before processing the update so the
 * public webhook endpoint cannot be driven by forged requests.
 *
 * Tri-state mirrors the cron guard:
 *  - "unconfigured": TELEGRAM_WEBHOOK_SECRET is not set (or too weak). We allow the
 *    request to avoid breaking already-running deployments, but the caller should
 *    log a loud warning. Configure the secret to close the hole.
 *  - "unauthorized": secret is configured but the header does not match.
 *  - "authorized": header matches the configured secret.
 */
export function telegramWebhookAuthorizationStatus(input: WebhookAuthorizationInput) {
  const secret = input.secret?.trim();
  if (!secret || secret.length < 16) return "unconfigured" as const;

  const provided = input.headerToken ?? "";
  const expectedBuffer = Buffer.from(secret);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return "unauthorized" as const;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer) ? ("authorized" as const) : ("unauthorized" as const);
}
