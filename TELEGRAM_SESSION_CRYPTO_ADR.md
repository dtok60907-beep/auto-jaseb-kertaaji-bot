# ADR — Telegram session encryption envelope

Status: accepted for F5.2
Date: 29 August 2026

## Decision

Telegram StringSession is encrypted with AES-256-GCM using a fresh random 96-bit
IV and an explicit 128-bit authentication tag. The binary envelope is versioned,
stores the key version, and authenticates the envelope header plus account UUID and
account type as additional authenticated data (AAD).

Keys are supplied as a strict versioned key ring. New ciphertext uses the active
version; decrypt selects the version stored both in the database column and envelope.
Old keys remain available during rotation until all corresponding rows are migrated.

## Why this differs from NEXO

NEXO's compact `[iv | tag | ciphertext]` AES-GCM layout is retained as a resource-
efficient foundation. It is not copied unchanged because it has no format marker,
key version, or AAD binding. Without context binding, valid ciphertext can be moved
between account rows without cryptographic detection.

## Envelope format 1

```text
magic "JSE1"     4 bytes
format version    1 byte
cipher id         1 byte
IV length         1 byte
tag length        1 byte
key version       4 bytes, unsigned big-endian
IV               12 bytes
authentication tag 16 bytes
ciphertext         remaining bytes
```

The fixed 12-byte header and external account context are authenticated as AAD.
The header is not secret. Ciphertext is stored in the existing PostgreSQL `bytea`
column; the existing `encryption_key_version` column must equal the envelope value.

## Operational rules

- Never log the environment key ring, plaintext session, or raw crypto error.
- A missing old key is an operational rotation error, not corrupt plaintext.
- Authentication failure deliberately does not distinguish wrong key, wrong account
  context, or tampering.
- Legacy/plaintext data is rejected; it is never guessed or auto-decoded.
- JavaScript strings cannot be reliably zeroed. Temporary plaintext `Buffer` objects
  are cleared, and decrypted strings must not be retained beyond the active adapter.

## Primary references

- Node.js 22 Crypto API: https://nodejs.org/download/release/v22.15.1/docs/api/crypto.html
- NIST SP 800-38D: https://csrc.nist.gov/pubs/sp/800/38/d/final
