function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

async function main(): Promise<void> {
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const webhookUrl = required("TELEGRAM_BOT_WEBHOOK_URL");
  const secretToken = required("TELEGRAM_WEBHOOK_SECRET");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("TELEGRAM_WEBHOOK_REQUEST_FAILED");
  }
  const body = await response.json().catch(() => null) as { ok?: unknown } | null;
  if (!response.ok || body?.ok !== true) throw new Error("TELEGRAM_WEBHOOK_CONFIGURATION_FAILED");
  process.stdout.write(`${JSON.stringify({ status: "TELEGRAM_WEBHOOK_CONFIGURED" })}\n`);
}

try { await main(); }
catch (error) {
  const code = error instanceof Error && /^([A-Z][A-Z0-9_]+)$/.test(error.message)
    ? error.message
    : "TELEGRAM_WEBHOOK_CONFIGURATION_FAILED";
  process.stderr.write(`${JSON.stringify({ code })}\n`);
  process.exitCode = 1;
}
