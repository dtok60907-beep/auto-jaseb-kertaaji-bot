const MAX_TELEGRAM_USER_ID = 4_503_599_627_370_495n;

export type CanaryOperatorCommand =
  | Readonly<{ kind: "LIST" }>
  | Readonly<{
      kind: "ADMIT" | "REVOKE" | "GRANT_ADMIN" | "REVOKE_ADMIN";
      telegramUserId: string;
    }>;

export type CanaryAdmissionChange = Readonly<{
  status: "ADMITTED" | "ALREADY_ADMITTED" | "LIMIT_REACHED" | "REVOKED" | "NOT_ADMITTED";
  telegramUserId: string;
  slot: number | null;
}>;

export type CanaryAdminChange = Readonly<{
  status: "ADMIN_GRANTED" | "ADMIN_REVOKED" | "APP_USER_NOT_FOUND" | "ADMIN_NOT_ACTIVE";
  telegramUserId: string;
}>;

export type CanaryOperatorView = Readonly<{
  telegramUserId: string;
  slot: number | null;
  admittedAt: string;
  revokedAt: string | null;
  appUserReady: boolean;
  adminActive: boolean;
}>;

export interface CanaryOperatorRepository {
  setAdmission(telegramUserId: string, enabled: boolean): Promise<CanaryAdmissionChange>;
  setAdmin(telegramUserId: string, enabled: boolean): Promise<CanaryAdminChange>;
  list(): Promise<readonly CanaryOperatorView[]>;
}

export class CanaryOperatorInputError extends Error {
  readonly code: "INVALID_CANARY_OPERATOR_COMMAND" | "INVALID_TELEGRAM_USER_ID";

  constructor(code: CanaryOperatorInputError["code"]) {
    super(code);
    this.name = "CanaryOperatorInputError";
    this.code = code;
  }
}

function telegramUserId(value: string | undefined): string {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new CanaryOperatorInputError("INVALID_TELEGRAM_USER_ID");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_TELEGRAM_USER_ID) {
    throw new CanaryOperatorInputError("INVALID_TELEGRAM_USER_ID");
  }
  return parsed.toString();
}

export function parseCanaryOperatorCommand(args: readonly string[]): CanaryOperatorCommand {
  if (args.length === 1 && args[0] === "list") return Object.freeze({ kind: "LIST" });
  if (args.length !== 2) throw new CanaryOperatorInputError("INVALID_CANARY_OPERATOR_COMMAND");
  const id = telegramUserId(args[1]);
  const kinds = {
    admit: "ADMIT",
    revoke: "REVOKE",
    "grant-admin": "GRANT_ADMIN",
    "revoke-admin": "REVOKE_ADMIN",
  } as const;
  const kind = kinds[args[0] as keyof typeof kinds];
  if (!kind) throw new CanaryOperatorInputError("INVALID_CANARY_OPERATOR_COMMAND");
  return Object.freeze({ kind, telegramUserId: id });
}

export async function executeCanaryOperator(
  command: CanaryOperatorCommand,
  repository: CanaryOperatorRepository,
) {
  if (command.kind === "LIST") return Object.freeze({ admissions: await repository.list() });
  if (command.kind === "ADMIT") return repository.setAdmission(command.telegramUserId, true);
  if (command.kind === "REVOKE") return repository.setAdmission(command.telegramUserId, false);
  if (command.kind === "GRANT_ADMIN") return repository.setAdmin(command.telegramUserId, true);
  return repository.setAdmin(command.telegramUserId, false);
}
