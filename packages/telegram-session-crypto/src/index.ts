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
  "AUTH_STATE_CONTEXT_INVALID",
  "AUTH_STATE_VALUE_INVALID",
  "AUTH_STATE_ENVELOPE_INVALID",
  "AUTH_STATE_ENVELOPE_UNSUPPORTED",
  "AUTH_STATE_KEY_VERSION_MISMATCH",
  "AUTH_STATE_AUTH_FAILED",
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
export type TelegramAuthFlowContext = Readonly<{ authFlowId: string }>;
export type EncryptedTelegramAuthState = Readonly<{
  ciphertext: Buffer;
  keyVersion: number;
}>;

const ALGORITHM = "aes-256-gcm";
const SESSION_MAGIC = Buffer.from("JSE1", "ascii");
const AUTH_STATE_MAGIC = Buffer.from("JAF1", "ascii");
const FORMAT_VERSION = 1;
const CIPHER_ID_AES_256_GCM = 1;
const HEADER_LENGTH = 12;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_KEYS = 32;
const MAX_SERIALIZED_KEYRING_BYTES = 4_096;
const MAX_SESSION_BYTES = 65_536;
const MAX_AUTH_STATE_BYTES = 131_032;
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

function sessionContextData(context: TelegramSessionContext): Readonly<{ accountId: string; accountType: TelegramSessionAccountType }> {
  if (
    typeof context !== "object" || context === null
    || typeof context.accountId !== "string" || !UUID.test(context.accountId)
    || (context.accountType !== "JASEB_WORKER" && context.accountType !== "USERBOT")
  ) fail("SESSION_CONTEXT_INVALID");
  return Object.freeze({ accountId: context.accountId.toLowerCase(), accountType: context.accountType });
}

function authFlowContextData(context: TelegramAuthFlowContext): Readonly<{ authFlowId: string }> {
  if (
    typeof context !== "object" || context === null
    || typeof context.authFlowId !== "string" || !UUID.test(context.authFlowId)
  ) fail("AUTH_STATE_CONTEXT_INVALID");
  return Object.freeze({ authFlowId: context.authFlowId.toLowerCase() });
}

function sessionAad(header: Buffer, context: ReturnType<typeof sessionContextData>): Buffer {
  return Buffer.concat([
    header,
    Buffer.from(`\0jaseb.telegram-session\0${context.accountId}\0${context.accountType}`, "utf8"),
  ]);
}

function authStateAad(header: Buffer, context: ReturnType<typeof authFlowContextData>): Buffer {
  return Buffer.concat([
    header,
    Buffer.from(`\0jaseb.telegram-auth-flow\0${context.authFlowId}`, "utf8"),
  ]);
}

function header(version: number, magic: Buffer): Buffer {
  const value = Buffer.alloc(HEADER_LENGTH);
  magic.copy(value, 0);
  value.writeUInt8(FORMAT_VERSION, 4);
  value.writeUInt8(CIPHER_ID_AES_256_GCM, 5);
  value.writeUInt8(IV_LENGTH, 6);
  value.writeUInt8(TAG_LENGTH, 7);
  value.writeUInt32BE(version, 8);
  return value;
}

type EnvelopeErrorCodes = Readonly<{
  value: TelegramSessionCryptoErrorCode;
  invalid: TelegramSessionCryptoErrorCode;
  unsupported: TelegramSessionCryptoErrorCode;
  version: TelegramSessionCryptoErrorCode;
  auth: TelegramSessionCryptoErrorCode;
}>;

function encryptSecret(input: Readonly<{
  key: KeyObject;
  keyVersion: number;
  magic: Buffer;
  aad: (header: Buffer) => Buffer;
  value: string;
  maximumBytes: number;
  valueError: TelegramSessionCryptoErrorCode;
}>): EncryptedTelegramSession {
  if (typeof input.value !== "string" || !input.value.trim()) fail(input.valueError);
  const plaintext = Buffer.from(input.value, "utf8");
  if (plaintext.length < 1 || plaintext.length > input.maximumBytes) {
    plaintext.fill(0);
    fail(input.valueError);
  }
  const envelopeHeader = header(input.keyVersion, input.magic);
  const iv = randomBytes(IV_LENGTH);
  try {
    const cipher = createCipheriv(ALGORITHM, input.key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(input.aad(envelopeHeader));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Object.freeze({
      ciphertext: Buffer.concat([envelopeHeader, iv, tag, ciphertext]),
      keyVersion: input.keyVersion,
    });
  } finally {
    plaintext.fill(0);
  }
}

function decryptSecret(input: Readonly<{
  keyForVersion: (version: number) => KeyObject | undefined;
  magic: Buffer;
  aad: (header: Buffer) => Buffer;
  ciphertext: Uint8Array;
  keyVersion: number;
  maximumBytes: number;
  errors: EnvelopeErrorCodes;
}>): string {
  const expectedKeyVersion = keyVersion(input?.keyVersion, input.errors.version);
  if (!(input?.ciphertext instanceof Uint8Array)) fail(input.errors.invalid);
  const envelope = Buffer.from(input.ciphertext);
  const minimumLength = HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + 1;
  const maximumLength = HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + input.maximumBytes;
  if (envelope.length < minimumLength || envelope.length > maximumLength) fail(input.errors.invalid);

  const envelopeHeader = envelope.subarray(0, HEADER_LENGTH);
  if (!envelopeHeader.subarray(0, input.magic.length).equals(input.magic)) fail(input.errors.invalid);
  if (envelopeHeader.readUInt8(4) !== FORMAT_VERSION || envelopeHeader.readUInt8(5) !== CIPHER_ID_AES_256_GCM) fail(input.errors.unsupported);
  if (envelopeHeader.readUInt8(6) !== IV_LENGTH || envelopeHeader.readUInt8(7) !== TAG_LENGTH) fail(input.errors.invalid);
  const envelopeKeyVersion = envelopeHeader.readUInt32BE(8);
  if (envelopeKeyVersion !== expectedKeyVersion) fail(input.errors.version);
  const selectedKey = input.keyForVersion(envelopeKeyVersion);
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
    decipher.setAAD(input.aad(envelopeHeader));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail(input.errors.auth);
  }

  try {
    const value = plaintext.toString("utf8");
    const reencoded = Buffer.from(value, "utf8");
    try {
      if (!value.trim() || !reencoded.equals(plaintext)) fail(input.errors.value);
      return value;
    } finally {
      reencoded.fill(0);
    }
  } finally {
    plaintext.fill(0);
  }
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
    const normalizedContext = sessionContextData(context);
    const version = this.activeKeyVersion;
    const selectedKey = this.#keys.get(version);
    if (!selectedKey) fail("SESSION_KEY_NOT_FOUND");
    return encryptSecret({
      key: selectedKey,
      keyVersion: version,
      magic: SESSION_MAGIC,
      aad: (envelopeHeader) => sessionAad(envelopeHeader, normalizedContext),
      value: session,
      maximumBytes: MAX_SESSION_BYTES,
      valueError: "SESSION_VALUE_INVALID",
    });
  }

  decrypt(
    context: TelegramSessionContext,
    input: Readonly<{ ciphertext: Uint8Array; keyVersion: number }>,
  ): string {
    const normalizedContext = sessionContextData(context);
    return decryptSecret({
      keyForVersion: (version) => this.#keys.get(version),
      magic: SESSION_MAGIC,
      aad: (envelopeHeader) => sessionAad(envelopeHeader, normalizedContext),
      ciphertext: input?.ciphertext,
      keyVersion: input?.keyVersion,
      maximumBytes: MAX_SESSION_BYTES,
      errors: {
        value: "SESSION_VALUE_INVALID",
        invalid: "SESSION_ENVELOPE_INVALID",
        unsupported: "SESSION_ENVELOPE_UNSUPPORTED",
        version: "SESSION_KEY_VERSION_MISMATCH",
        auth: "SESSION_AUTH_FAILED",
      },
    });
  }

  encryptAuthState(context: TelegramAuthFlowContext, state: string): EncryptedTelegramAuthState {
    const normalizedContext = authFlowContextData(context);
    const version = this.activeKeyVersion;
    const selectedKey = this.#keys.get(version);
    if (!selectedKey) fail("SESSION_KEY_NOT_FOUND");
    return encryptSecret({
      key: selectedKey,
      keyVersion: version,
      magic: AUTH_STATE_MAGIC,
      aad: (envelopeHeader) => authStateAad(envelopeHeader, normalizedContext),
      value: state,
      maximumBytes: MAX_AUTH_STATE_BYTES,
      valueError: "AUTH_STATE_VALUE_INVALID",
    });
  }

  decryptAuthState(
    context: TelegramAuthFlowContext,
    input: Readonly<{ ciphertext: Uint8Array; keyVersion: number }>,
  ): string {
    const normalizedContext = authFlowContextData(context);
    return decryptSecret({
      keyForVersion: (version) => this.#keys.get(version),
      magic: AUTH_STATE_MAGIC,
      aad: (envelopeHeader) => authStateAad(envelopeHeader, normalizedContext),
      ciphertext: input?.ciphertext,
      keyVersion: input?.keyVersion,
      maximumBytes: MAX_AUTH_STATE_BYTES,
      errors: {
        value: "AUTH_STATE_VALUE_INVALID",
        invalid: "AUTH_STATE_ENVELOPE_INVALID",
        unsupported: "AUTH_STATE_ENVELOPE_UNSUPPORTED",
        version: "AUTH_STATE_KEY_VERSION_MISMATCH",
        auth: "AUTH_STATE_AUTH_FAILED",
      },
    });
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
