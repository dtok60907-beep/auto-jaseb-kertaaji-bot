# Telegram session crypto

Shared encryption boundary for Telegram StringSession values. Account onboarding
encrypts with this package and the Telegram engine decrypts with the same package.

Environment contract:

```dotenv
TELEGRAM_SESSION_ACTIVE_KEY_VERSION=2
TELEGRAM_SESSION_KEYS={"1":"<64 hex characters>","2":"<64 hex characters>"}
```

Generate each 256-bit key outside the repository with `openssl rand -hex 32`.
Never remove an old version while database rows still reference it. Never print,
commit, or send the JSON key ring to a client.

The binary envelope is documented in `TELEGRAM_SESSION_CRYPTO_ADR.md`. Legacy raw
strings and the unversioned NEXO envelope are deliberately rejected rather than
guessed.
