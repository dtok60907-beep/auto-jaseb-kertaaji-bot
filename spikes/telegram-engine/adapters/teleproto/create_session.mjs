import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

function requiredEnv(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const rl = readline.createInterface({ input, output });
const apiId = Number(requiredEnv("TELEGRAM_TEST_API_ID"));
const apiHash = requiredEnv("TELEGRAM_TEST_API_HASH");
const twoFactorPassword = process.env.TELEPROTO_2FA_PASSWORD ?? "";
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
});

try {
  await client.start({
    phoneNumber: () => rl.question("Nomor Telegram (+62...): "),
    phoneCode: () => rl.question("OTP Telegram: "),
    password: async () => twoFactorPassword,
    onError: (error) => {
      console.error(`Login gagal: ${error.message}`);
      return true;
    },
  });

  console.log("\nSALIN BARIS INI KE spikes/telegram-engine/.env:");
  console.log(`TELEPROTO_TEST_SESSION=${client.session.save()}`);
} finally {
  rl.close();
  await client.disconnect();
}
