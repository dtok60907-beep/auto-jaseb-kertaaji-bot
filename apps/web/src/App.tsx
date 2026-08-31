import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  cancelTelegramAuthorization,
  detachTelegramAccount,
  exchangeTelegramInitData,
  listTelegramAccounts,
  logoutTelegramAccount,
  startTelegramAuthorization,
  submitTelegramCode,
  submitTelegramPassword,
  switchTelegramAccount,
} from "./api";
import type { AuthFlow, AuthorizationResult, IssuedSession, TelegramAccount } from "./types";

const SESSION_STORAGE_KEY = "jaseb.telegram.api-session";

type AuthStatus = "CHECKING" | "READY" | "TELEGRAM_REQUIRED" | "ERROR";
type ActionState = "SWITCH" | "DETACH" | "LOGOUT" | null;

const STATUS_LABEL: Record<TelegramAccount["status"], string> = {
  CONNECTING: "Sedang tersambung",
  DISCONNECTED: "Tidak aktif",
  READY: "Siap digunakan",
  DEGRADED: "Perlu perhatian",
  REVOKED: "Akses dicabut",
  DISABLED: "Dinonaktifkan",
};

const ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi ke server sedang bermasalah. Coba lagi.",
  REQUEST_FAILED: "Permintaan belum berhasil. Coba lagi.",
  AUTH_TEMPORARILY_UNAVAILABLE: "Layanan sedang sibuk. Coba lagi beberapa saat lagi.",
  SUBSCRIPTION_REQUIRED: "Paket Userbot belum aktif di akun ini.",
  SUBSCRIPTION_EXPIRED: "Paket Userbot kamu sudah berakhir.",
  AUTH_FLOW_ACTIVE: "Masih ada proses koneksi yang berjalan.",
  AUTH_FLOW_EXPIRED: "Waktu koneksi habis. Mulai lagi dari awal.",
  AUTH_FLOW_CONFLICT: "Proses ini berubah di perangkat lain. Muat ulang lalu coba lagi.",
  PHONE_NUMBER_INVALID: "Nomor telepon belum sesuai format.",
  PHONE_CODE_INVALID: "Kode yang dimasukkan belum benar.",
  PHONE_CODE_EXPIRED: "Kode sudah kedaluwarsa. Mulai lagi dari awal.",
  PASSWORD_INVALID: "Kata sandi Telegram belum benar.",
  TELEGRAM_RATE_LIMITED: "Telegram meminta kita menunggu sebelum mencoba lagi.",
  TELEGRAM_UNAVAILABLE: "Telegram belum bisa dihubungi. Coba lagi nanti.",
  ACCOUNT_ALREADY_CONNECTED: "Akun Telegram itu sudah terhubung.",
  ACCOUNT_NOT_FOUND: "Akun tidak ditemukan atau bukan milik kamu.",
  ACCOUNT_NOT_READY: "Akun belum siap digunakan.",
  ACCOUNT_OPERATION_UNAVAILABLE: "Perubahan akun belum bisa diproses. Coba lagi.",
};

function errorLabel(error: unknown): string {
  if (error instanceof ApiError) return ERROR_LABEL[error.code] ?? "Permintaan belum berhasil. Coba lagi.";
  return "Permintaan belum berhasil. Coba lagi.";
}

function readStoredSession(): IssuedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IssuedSession>;
    if (
      typeof parsed.accessToken !== "string"
      || typeof parsed.expiresAt !== "string"
      || !parsed.user
      || typeof parsed.user.id !== "string"
      || typeof parsed.user.telegramUserId !== "string"
      || Date.parse(parsed.expiresAt) <= Date.now()
    ) return null;
    return parsed as IssuedSession;
  } catch {
    return null;
  }
}

function saveSession(session: IssuedSession): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function formatDate(value: string | null): string {
  if (!value) return "Belum diketahui";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Belum diketahui";
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function formatRemaining(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(value) - Date.now()) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} menit lagi` : `${seconds} detik lagi`;
}

function statusClass(status: TelegramAccount["status"]): string {
  return `status-dot status-dot--${status.toLowerCase()}`;
}

function updateFlow(result: AuthorizationResult): AuthFlow | null {
  return result.status === "CONNECTED" ? null : result.flow;
}

function LoadingScreen() {
  return (
    <main className="page page--centered" aria-busy="true">
      <div className="loading-orbit" aria-hidden="true"><span /></div>
      <p className="loading-copy">Menyiapkan ruang akun kamu</p>
    </main>
  );
}

function TelegramRequired({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="page page--centered page--auth">
      <div className="auth-card">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow">Ruang akun Telegram</p>
        <h1>Bawa akunmu ke tempat yang lebih rapi.</h1>
        <p className="auth-copy">
          Buka halaman ini dari Mini App Telegram supaya identitasmu bisa diverifikasi dengan aman.
        </p>
        <button className="button button--primary button--wide" type="button" onClick={onRetry}>
          Coba lagi
        </button>
        <p className="helper-text">Halaman ini tidak menerima token yang ditempel manual.</p>
      </div>
    </main>
  );
}

function AccountCard({
  account,
  action,
  onSwitch,
  onDetach,
  onLogout,
}: {
  account: TelegramAccount;
  action: ActionState;
  onSwitch: (account: TelegramAccount) => void;
  onDetach: () => void;
  onLogout: (account: TelegramAccount) => void;
}) {
  const canSwitch = !account.active && account.status === "READY" && action === null;
  const canDetach = account.active && action === null;
  const canLogout = account.sessionPresent && account.status !== "CONNECTING" && action === null;

  return (
    <article className={`account-card ${account.active ? "account-card--active" : ""}`}>
      <div className="account-card__topline">
        <div className="account-identity">
          <span className={statusClass(account.status)} aria-hidden="true" />
          <div>
            <h3>{account.label}</h3>
            <p>{account.active ? "Akun aktif" : "Akun tersimpan"}</p>
          </div>
        </div>
        {account.active && <span className="active-badge">Dipakai sekarang</span>}
      </div>
      <div className="account-card__details">
        <div><span>Status</span><strong>{STATUS_LABEL[account.status]}</strong></div>
        <div><span>Terhubung</span><strong>{formatDate(account.authenticatedAt)}</strong></div>
        <div><span>Session</span><strong>{account.sessionPresent ? "Tersimpan aman" : "Belum tersedia"}</strong></div>
      </div>
      {account.lastErrorCode && (
        <p className="account-warning">{ERROR_LABEL[account.lastErrorCode] ?? "Akun perlu diperiksa."}</p>
      )}
      <div className="account-card__actions">
        {account.active ? (
          <button className="button button--soft" type="button" disabled>Pengaturan aktif</button>
        ) : (
          <button className="button button--soft" type="button" disabled={!canSwitch} onClick={() => onSwitch(account)}>
            {action === "SWITCH" ? "Mengganti akun" : "Pakai akun ini"}
          </button>
        )}
        {account.active && (
          <button className="button button--ghost" type="button" disabled={!canDetach} onClick={onDetach}>
            {action === "DETACH" ? "Melepas akun" : "Lepas dari Userbot"}
          </button>
        )}
        {canLogout || action === "LOGOUT" ? (
          <button className="button button--danger-ghost" type="button" disabled={action !== null} onClick={() => onLogout(account)}>
            {action === "LOGOUT" ? "Menghapus session" : "Logout"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ConnectDialog({
  token,
  onClose,
  onConnected,
}: {
  token: string;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [flow, setFlow] = useState<AuthFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const expired = flow ? Date.parse(flow.expiresAt) <= now : false;
  const submitPhone = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await startTelegramAuthorization(token, phoneNumber);
      if (result.status === "CONNECTED") {
        await onConnected(); onClose(); return;
      }
      setFlow(result.flow);
    } catch (cause) { setError(errorLabel(cause)); }
    finally { setBusy(false); }
  };
  const submitCode = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!flow) return;
    setBusy(true); setError(null);
    try {
      const result = await submitTelegramCode(token, flow, code);
      if (result.status === "CONNECTED") {
        await onConnected(); onClose(); return;
      }
      setFlow(updateFlow(result));
      setCode("");
    } catch (cause) {
      setError(errorLabel(cause));
      if (cause instanceof ApiError && cause.code === "AUTH_FLOW_EXPIRED") setFlow(null);
    } finally { setBusy(false); }
  };
  const submitPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!flow) return;
    setBusy(true); setError(null);
    try {
      const result = await submitTelegramPassword(token, flow, password);
      if (result.status === "CONNECTED") {
        await onConnected(); onClose(); return;
      }
      setFlow(updateFlow(result));
      setPassword("");
    } catch (cause) { setError(errorLabel(cause)); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!flow || busy) { onClose(); return; }
    setBusy(true); setError(null);
    try { await cancelTelegramAuthorization(token, flow); onClose(); }
    catch (cause) { setError(errorLabel(cause)); setBusy(false); }
  };

  return (
    <div className="modal-layer" role="presentation">
      <div className="modal-backdrop" onClick={cancel} />
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <div className="modal-head">
          <div><p className="eyebrow">Akun baru</p><h2 id="connect-title">Hubungkan Telegram</h2></div>
          <button className="close-button" type="button" onClick={cancel} aria-label="Tutup">Tutup</button>
        </div>
        {!flow && (
          <form className="stack-form" onSubmit={submitPhone}>
            <p className="modal-intro">Nomor ini hanya dipakai untuk meminta kode masuk dari Telegram.</p>
            <label htmlFor="phone">Nomor telepon</label>
            <input id="phone" inputMode="tel" autoComplete="tel" placeholder="+62 812 3456 7890" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} required />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? "Meminta kode" : "Kirim kode"}</button>
            <p className="helper-text">Pastikan nomor ini punya akses ke Telegram di perangkatmu.</p>
          </form>
        )}
        {flow?.status === "CODE_REQUIRED" && !expired && (
          <form className="stack-form" onSubmit={submitCode}>
            <div className="step-count"><span>Langkah 2 dari 3</span><strong>{formatRemaining(flow.expiresAt)}</strong></div>
            <p className="modal-intro">Masukkan kode yang dikirim Telegram ke perangkatmu.</p>
            <label htmlFor="code">Kode Telegram</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" placeholder="12345" value={code} onChange={(event) => setCode(event.target.value)} required />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? "Memeriksa kode" : "Lanjutkan"}</button>
            <button className="text-button" type="button" onClick={() => setFlow(null)} disabled={busy}>Ganti nomor</button>
          </form>
        )}
        {flow?.status === "PASSWORD_REQUIRED" && !expired && (
          <form className="stack-form" onSubmit={submitPassword}>
            <div className="step-count"><span>Langkah 3 dari 3</span><strong>{formatRemaining(flow.expiresAt)}</strong></div>
            <p className="modal-intro">Akun ini memakai verifikasi dua langkah. Masukkan kata sandi Telegram kamu.</p>
            <label htmlFor="password">Kata sandi Telegram</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? "Memeriksa" : "Hubungkan akun"}</button>
          </form>
        )}
        {flow && expired && (
          <div className="expired-state">
            <p className="eyebrow">Waktu habis</p>
            <h3>Proses koneksi perlu diulang.</h3>
            <p>Kode Telegram hanya berlaku sebentar untuk menjaga akunmu tetap aman.</p>
            <button className="button button--primary button--wide" type="button" onClick={() => { setFlow(null); setError(null); }}>Mulai lagi</button>
          </div>
        )}
        {error && !flow && null}
      </section>
    </div>
  );
}

function LogoutDialog({ account, busy, onClose, onConfirm }: { account: TelegramAccount; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-layer" role="presentation">
      <div className="modal-backdrop" onClick={onClose} />
      <section className="modal-card modal-card--small" role="dialog" aria-modal="true" aria-labelledby="logout-title">
        <p className="eyebrow">Hapus session</p>
        <h2 id="logout-title">Logout dari {account.label}?</h2>
        <p className="modal-intro">Session Telegram akan dihapus dari server. Pengaturan Userbot dan langganan tetap ada.</p>
        <div className="confirm-actions">
          <button className="button button--ghost" type="button" onClick={onClose} disabled={busy}>Batal</button>
          <button className="button button--danger" type="button" onClick={onConfirm} disabled={busy}>{busy ? "Menghapus" : "Ya, logout"}</button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("CHECKING");
  const [session, setSession] = useState<IssuedSession | null>(null);
  const [accounts, setAccounts] = useState<readonly TelegramAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [logoutAccount, setLogoutAccount] = useState<TelegramAccount | null>(null);

  const loadAccounts = useCallback(async (accessToken: string) => {
    setLoadingAccounts(true); setPageError(null);
    try { setAccounts(await listTelegramAccounts(accessToken)); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        clearSession(); setSession(null); setAuthStatus("TELEGRAM_REQUIRED");
      } else setPageError(errorLabel(cause));
    } finally { setLoadingAccounts(false); }
  }, []);

  const authenticate = useCallback(async () => {
    const webApp = window.Telegram?.WebApp;
    webApp?.ready(); webApp?.expand();
    const stored = readStoredSession();
    if (stored) { setSession(stored); setAuthStatus("READY"); await loadAccounts(stored.accessToken); return; }
    clearSession();
    if (!webApp?.initData) { setAuthStatus("TELEGRAM_REQUIRED"); return; }
    setAuthStatus("CHECKING");
    try {
      const issued = await exchangeTelegramInitData(webApp.initData);
      saveSession(issued); setSession(issued); setAuthStatus("READY"); await loadAccounts(issued.accessToken);
    } catch { setAuthStatus("ERROR"); }
  }, [loadAccounts]);

  useEffect(() => { void authenticate(); }, [authenticate]);

  const activeAccount = useMemo(() => accounts.find((account) => account.active) ?? null, [accounts]);
  const runAccountAction = async (nextAction: Exclude<ActionState, null>, account?: TelegramAccount) => {
    if (!session || action) return;
    setAction(nextAction); setPageError(null);
    try {
      if (nextAction === "SWITCH" && account) await switchTelegramAccount(session.accessToken, account.id);
      if (nextAction === "DETACH") await detachTelegramAccount(session.accessToken);
      if (nextAction === "LOGOUT" && account) await logoutTelegramAccount(session.accessToken, account.id);
      await loadAccounts(session.accessToken);
      if (nextAction === "LOGOUT") setLogoutAccount(null);
    } catch (cause) { setPageError(errorLabel(cause)); }
    finally { setAction(null); }
  };

  if (authStatus === "CHECKING") return <LoadingScreen />;
  if (authStatus === "TELEGRAM_REQUIRED" || authStatus === "ERROR" || !session) return <TelegramRequired onRetry={() => void authenticate()} />;

  return (
    <main className="page">
      <header className="topbar">
        <div className="wordmark"><span className="wordmark-dot" aria-hidden="true" />kertaaji</div>
        <div className="topbar-meta"><span className="live-pill"><span aria-hidden="true" />Terhubung</span><span className="user-label">Akun Telegram</span></div>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Ruang akun</p>
          <h1>Semua akun Telegram, <em>tetap terkendali.</em></h1>
          <p className="hero-description">Hubungkan akunmu, pilih yang ingin dipakai, dan lepas kapan saja. Pengaturan dan langgananmu tidak ikut berpindah.</p>
        </div>
        <div className="hero-note"><span className="note-line" aria-hidden="true" /><p>Session disimpan terenkripsi dan hanya dibuka saat Userbot bekerja.</p></div>
      </section>
      <section className="content-section" aria-labelledby="accounts-heading">
        <div className="section-heading"><div><p className="eyebrow">Akun tersimpan</p><h2 id="accounts-heading">Pilih akun kerja</h2></div><button className="button button--primary" type="button" onClick={() => setConnectOpen(true)}>Hubungkan akun</button></div>
        {pageError && <div className="notice notice--error" role="alert"><span>{pageError}</span><button className="text-button" type="button" onClick={() => setPageError(null)}>Tutup</button></div>}
        {loadingAccounts ? <div className="account-grid" aria-busy="true"><div className="account-skeleton" /><div className="account-skeleton" /></div> : accounts.length === 0 ? (
          <div className="empty-card"><div className="empty-mark" aria-hidden="true"><span /><span /></div><h3>Belum ada akun yang terhubung</h3><p>Hubungkan akun Telegram untuk mulai memakai Userbot dengan identitasmu sendiri.</p><button className="button button--primary" type="button" onClick={() => setConnectOpen(true)}>Hubungkan akun pertama</button></div>
        ) : (
          <div className="account-grid">{accounts.map((account) => <AccountCard key={account.id} account={account} action={action} onSwitch={(item) => void runAccountAction("SWITCH", item)} onDetach={() => void runAccountAction("DETACH")} onLogout={setLogoutAccount} />)}</div>
        )}
      </section>
      {activeAccount && <footer className="page-footer"><span className={statusClass(activeAccount.status)} aria-hidden="true" />{activeAccount.label} sedang menjadi akun aktif Userbot.</footer>}
      {connectOpen && <ConnectDialog token={session.accessToken} onClose={() => setConnectOpen(false)} onConnected={() => loadAccounts(session.accessToken)} />}
      {logoutAccount && <LogoutDialog account={logoutAccount} busy={action === "LOGOUT"} onClose={() => { if (!action) setLogoutAccount(null); }} onConfirm={() => void runAccountAction("LOGOUT", logoutAccount)} />}
    </main>
  );
}
