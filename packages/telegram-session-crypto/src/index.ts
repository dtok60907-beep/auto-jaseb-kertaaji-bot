import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export const TELEGRAM_SESSION_CRYPTO_ERROR_CODES = [
  "SESSION_KEYRING_INVALID",
  "SESSION_KEY_NOT_FOUND",
  "SESSION_CONTEXT_INVALID",
  "SESSION_VALUE_INVALID",
  "SESSION_ENVELOPE_INVALID",
  "SESSION_ENVELOPE_UNSUPPORTED",
  "SESSION_KEY_VERSION_MISMATCH",
  "SESSION_AUTH_FAILED",
] as const;

export type TelegramSessionCryptoErrorCode = (typeof TELEGRAM_SESSION_CRYPTO_ERROR_CODES)[number];
export type TelegramSessionAccountType = "JASEB_WORKER" | "USERBOT";
export type TelegramSessionContext = Readonly<{
  accountId: string;
  accountType: TelegramSessionAccountType;
}>;
export type EncryptedTelegramSession = Readonly<{
  ciphertext: Buffer;
  keyVersion: number;
}>;

const ALGORITHM = "aes-256-gcm";
const MAGIC = Buffer.from("JSE1", "ascii");
const FORMAT_VERSION = 1;
const CIPHER_ID_AES_256_GCM = 1;
const HEADER_LENGTH = 12;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_KEYS = 32;
const MAX_SERIALIZED_KEYRING_BYTES = 4_096;
const MAX_SESSION_BYTES = 65_536;
const MAX_KEY_VERSION = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class TelegramSessionCryptoError extends Error {
  readonly code: TelegramSessionCryptoErrorCode;

  constructor(code: TelegramSessionCryptoErrorCode) {
    super(code);
    this.name = "TelegramSessionCryptoError";
    this.code = code;
  }

  publicData(): Readonly<{ code: TelegramSessionCryptoErrorCode }> {
    return Object.freeze({ code: this.code });
  }

  toJSON(): Readonly<{ code: TelegramSessionCryptoErrorCode }> {
    return this.publicData();
  }
}

function fail(code: TelegramSessionCryptoErrorCode): never {
  throw new TelegramSessionCryptoError(code);
}

function keyVersion(value: unknown, errorCode: TelegramSessionCryptoErrorCode): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_KEY_VERSION) fail(errorCode);
  return value;
}

function contextData(context: TelegramSessionContext): Readonly<{ accountId: string; accountType: TelegramSessionAccountType }> {
  if (
    typeof context !== "object" || context === null
    || typeof context.accountId !== "string" || !UUID.test(context.accountId)
    || (context.accountType !== "JASEB_WORKER" && context.accountType !== "USERBOT")
  ) fail("SESSION_CONTEXT_INVALID");
  return Object.freeze({ accountId: context.accountId.toLowerCase(), accountType: context.accountType });
}

function aad(header: Buffer, context: ReturnType<typeof contextData>): Buffer {
  return Buffer.concat([
    header,
    Buffer.from(`\0jaseb.telegram-session\0${context.accountId}\0${context.accountType}`, "utf8"),
  ]);
}

function header(version: number): Buffer {
  const value = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(value, 0);
  value.writeUInt8(FORMAT_VERSION, 4);
  value.writeUInt8(CIPHER_ID_AES_256_GCM, 5);
  value.writeUInt8(IV_LENGTH, 6);
  value.writeUInt8(TAG_LENGTH, 7);
  value.writeUInt32BE(version, 8);
  return value;
}

function parseHexKeys(input: Readonly<Record<string, string>>): ReadonlyMap<number, KeyObject> {
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > MAX_KEYS) fail("SESSION_KEYRING_INVALID");
  const keys = new Map<number, KeyObject>();
  for (const [rawVersion, hex] of entries) {
    if (!/^[1-9][0-9]*$/.test(rawVersion) || typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) fail("SESSION_KEYRING_INVALID");
    const version = keyVersion(Number(rawVersion), "SESSION_KEYRING_INVALID");
    if (keys.has(version)) fail("SESSION_KEYRING_INVALID");
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length !== KEY_LENGTH) fail("SESSION_KEYRING_INVALID");
    try {
      keys.set(version, createSecretKey(bytes));
    } finally {
      bytes.fill(0);
    }
  }
  return keys;
}

export class TelegramSessionKeyRing {
  readonly activeKeyVersion: number;
  readonly #keys: ReadonlyMap<number, KeyObject>;

  private constructor(activeKeyVersion: number, keys: ReadonlyMap<number, KeyObject>) {
    this.activeKeyVersion = activeKeyVersion;
    this.#keys = keys;
    Object.freeze(this);
  }

  static fromHexKeys(input: Readonly<{
    activeKeyVersion: number;
    keys: Readonly<Record<string, string>>;
  }>): TelegramSessionKeyRing {
    if (typeof input !== "object" || input === null || typeof input.keys !== "object" || input.keys === null || Array.isArray(input.keys)) fail("SESSION_KEYRING_INVALID");
    const activeKeyVersion = keyVersion(input.activeKeyVersion, "SESSION_KEYRING_INVALID");
    const keys = parseHexKeys(input.keys);
    if (!keys.has(activeKeyVersion)) fail("SESSION_KEYRING_INVALID");
    return new TelegramSessionKeyRing(activeKeyVersion, keys);
  }

  static fromEnvironment(env: Readonly<Record<string, string | undefined>>): TelegramSessionKeyRing {
    const serialized = env.TELEGRAM_SESSION_KEYS;
    const activeText = env.TELEGRAM_SESSION_ACTIVE_KEY_VERSION;
    if (
      typeof serialized !== "string" || !serialized.trim()
      || Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_KEYRING_BYTES
      || typeof activeText !== "string" || !/^[1-9][0-9]*$/.test(activeText)
    ) fail("SESSION_KEYRING_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      fail("SESSION_KEYRING_INVALID");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("SESSION_KEYRING_INVALID");
    return TelegramSessionKeyRing.fromHexKeys({
      activeKeyVersion: Number(activeText),
      keys: parsed as Readonly<Record<string, string>>,
    });
  }

  hasKeyVersion(version: number): boolean {
    return Number.isInteger(version) && this.#keys.has(version);
  }

  encrypt(context: TelegramSessionContext, session: string): EncryptedTelegramSession {
    const normalizedContext = contextData(context);
    if (typeof session !== "string" || !session.trim()) fail("SESSION_VALUE_INVALID");
    const plaintext = Buffer.from(session, "utf8");
    if (plaintext.length < 1 || plaintext.length > MAX_SESSION_BYTES) {
      plaintext.fill(0);
      fail("SESSION_VALUE_INVALID");
    }
    const version = this.activeKeyVersion;
    const selectedKey = this.#keys.get(version);
    if (!selectedKey) {
      plaintext.fill(0);
      fail("SESSION_KEY_NOT_FOUND");
    }
    const envelopeHeader = header(version);
    const iv = randomBytes(IV_LENGTH);
    try {
      const cipher = createCipheriv(ALGORITHM, selectedKey, iv, { authTagLength: TAG_LENGTH });
      cipher.setAAD(aad(envelopeHeader, normalizedContext));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Object.freeze({
        ciphertext: Buffer.concat([envelopeHeader, iv, tag, ciphertext]),
        keyVersion: version,
      });
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(
    context: TelegramSessionContext,
    input: Readonly<{ ciphertext: Uint8Array; keyVersion: number }>,
  ): string {
    const normalizedContext = contextData(context);
    const expectedKeyVersion = keyVersion(input?.keyVersion, "SESSION_KEY_VERSION_MISMATCH");
    if (!(input?.ciphertext instanceof Uint8Array)) fail("SESSION_ENVELOPE_INVALID");
    const envelope = Buffer.from(input.ciphertext);
    const minimumLength = HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
    const maximumLength = HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + MAX_SESSION_BYTES;
    if (envelope.length < minimumLength || envelope.length > maximumLength) fail("SESSION_ENVELOPE_INVALID");

    const envelopeHeader = envelope.subarray(0, HEADER_LENGTH);
    if (!envelopeHeader.subarray(0, MAGIC.length).equals(MAGIC)) fail("SESSION_ENVELOPE_INVALID");
    if (envelopeHeader.readUInt8(4) !== FORMAT_VERSION || envelopeHeader.readUInt8(5) !== CIPHER_ID_AES_256_GCM) fail("SESSION_ENVELOPE_UNSUPPORTED");
    if (envelopeHeader.readUInt8(6) !== IV_LENGTH || envelopeHeader.readUInt8(7) !== TAG_LENGTH) fail("SESSION_ENVELOPE_INVALID");
    const envelopeKeyVersion = envelopeHeader.readUInt32BE(8);
    if (envelopeKeyVersion !== expectedKeyVersion) fail("SESSION_KEY_VERSION_MISMATCH");
    const selectedKey = this.#keys.get(envelopeKeyVersion);
    if (!selectedKey) fail("SESSION_KEY_NOT_FOUND");

    const ivOffset = HEADER_LENGTH;
    const tagOffset = ivOffset + IV_LENGTH;
    const ciphertextOffset = tagOffset + TAG_LENGTH;
    const iv = envelope.subarray(ivOffset, tagOffset);
    const tag = envelope.subarray(tagOffset, ciphertextOffset);
    const ciphertext = envelope.subarray(ciphertextOffset);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(ALGORITHM, selectedKey, iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(aad(envelopeHeader, normalizedContext));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      fail("SESSION_AUTH_FAILED");
    }

    try {
      const session = plaintext.toString("utf8");
      const reencoded = Buffer.from(session, "utf8");
      try {
        if (!session.trim() || !reencoded.equals(plaintext)) fail("SESSION_VALUE_INVALID");
        return session;
      } finally {
        reencoded.fill(0);
      }
    } finally {
      plaintext.fill(0);
    }
  }

  toJSON(): Readonly<{ redacted: true; activeKeyVersion: number }> {
    return Object.freeze({ redacted: true, activeKeyVersion: this.activeKeyVersion });
  }

  toString(): string {
    return `TelegramSessionKeyRing(redacted, activeKeyVersion=${this.activeKeyVersion})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}
