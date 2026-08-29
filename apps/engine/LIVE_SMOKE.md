# F3 controlled Telegram smoke

This smoke performs real Telegram side effects against the dedicated test target:
one text send and one Telegram-native forward. It never starts OTP/2FA and never
prints API hash or StringSession values.

Run only with the dedicated test account and test group configured in
`spikes/telegram-engine/.env`:

```bash
set -a
source ../../spikes/telegram-engine/.env
set +a
TELEGRAM_F3_LIVE_SEND=1 npm run smoke:live
```

`TELEGRAM_TEST_FORWARD_SOURCE` may override the default controlled public source
`https://t.me/VadeMecums/204`. The command is deliberately blocked unless
`TELEGRAM_F3_LIVE_SEND=1` is present.
