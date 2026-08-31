export type TelegramCodeDelivery = "APP" | "SMS";

export type TelegramPendingAuthorization = Readonly<{
  phoneNumber: string;
  phoneCodeHash: string;
  session: string;
  codeDelivery: TelegramCodeDelivery;
}>;

export type TelegramVerifiedAuthorization = Readonly<{
  providerUserId: string;
  label: string;
  session: string;
}>;

export type TelegramCodeAuthorizationResult =
  | Readonly<{ status: "PASSWORD_REQUIRED"; pending: TelegramPendingAuthorization }>
  | Readonly<{ status: "AUTHORIZED"; verified: TelegramVerifiedAuthorization }>;

export interface TelegramAuthorizationTransport {
  requestCode(phoneNumber: string): Promise<TelegramPendingAuthorization>;
  submitCode(pending: TelegramPendingAuthorization, code: string): Promise<TelegramCodeAuthorizationResult>;
  submitPassword(
    pending: TelegramPendingAuthorization,
    password: string,
  ): Promise<TelegramVerifiedAuthorization>;
}

export type TelegramAuthorizationTransportErrorCode =
  | "PHONE_NUMBER_INVALID"
  | "PHONE_NUMBER_BANNED"
  | "PHONE_CODE_INVALID"
  | "PHONE_CODE_EXPIRED"
  | "PHONE_CODE_HASH_INVALID"
  | "PASSWORD_INVALID"
  | "TELEGRAM_RATE_LIMITED"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "NEW_ACCOUNT_NOT_SUPPORTED"
  | "AUTH_SESSION_EXPIRED"
  | "TELEGRAM_UNAVAILABLE"
  | "TELEGRAM_RESPONSE_INVALID";

export class TelegramAuthorizationTransportError extends Error {
  readonly code: TelegramAuthorizationTransportErrorCode;

  constructor(code: TelegramAuthorizationTransportErrorCode) {
    super(code);
    this.name = "TelegramAuthorizationTransportError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: TelegramAuthorizationTransportErrorCode }> {
    return Object.freeze({ code: this.code });
  }
}
