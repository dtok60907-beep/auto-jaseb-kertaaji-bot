import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  createAdminPackage,
  extendEntitlement,
  grantEntitlement,
  listAdminPackages,
  listAdminUsers,
  listEntitlements,
  listWorkerAccounts,
  revokeEntitlement,
  updateAdminPackage,
  updateWorkerAccount,
} from "./api";
import type { AdminUser, Entitlement, PackageInput, ServicePackage, WorkerAccount } from "./types";

type AdminSection = "USERS" | "PACKAGES" | "WORKERS";

type PackageForm = {
  code: string;
  name: string;
  type: ServicePackage["type"];
  priceIdr: string;
  durationDays: string;
  maxTargetsPerMinute: string;
  maxAccounts: string;
  intervalMinSeconds: string;
  intervalMaxSeconds: string;
  displayOrder: string;
  active: boolean;
};

const emptyPackageForm: PackageForm = {
  code: "",
  name: "",
  type: "USERBOT",
  priceIdr: "0",
  durationDays: "30",
  maxTargetsPerMinute: "1",
  maxAccounts: "1",
  intervalMinSeconds: "0",
  intervalMaxSeconds: "0",
  displayOrder: "0",
  active: true,
};

const API_ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi ke server sedang bermasalah.",
  AUTH_TEMPORARILY_UNAVAILABLE: "Akses admin belum bisa dicek saat ini.",
  INVALID_PACKAGE: "Isi paket belum sesuai.",
  PACKAGE_CODE_EXISTS: "Kode paket sudah dipakai.",
  INVALID_ENTITLEMENT: "Data akses belum sesuai.",
  ENTITLEMENT_NOT_FOUND: "Akses tidak ditemukan.",
  INVALID_WORKER_ACCOUNT_SETTING: "Pengaturan akun worker belum sesuai.",
};

function errorLabel(error: unknown): string {
  if (error instanceof ApiError) return API_ERROR_LABEL[error.code] ?? "Permintaan belum berhasil.";
  return "Permintaan belum berhasil.";
}

function formatDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Belum ada";
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
}

function userName(user: AdminUser): string {
  return user.username ? `@${user.username}` : user.firstName;
}

function packageForm(pkg: ServicePackage | null): PackageForm {
  if (!pkg) return { ...emptyPackageForm };
  return {
    code: pkg.code,
    name: pkg.name,
    type: pkg.type,
    priceIdr: String(pkg.priceIdr),
    durationDays: String(pkg.durationDays),
    maxTargetsPerMinute: String(pkg.maxTargetsPerMinute),
    maxAccounts: String(pkg.maxAccounts),
    intervalMinSeconds: String(pkg.intervalMinSeconds),
    intervalMaxSeconds: String(pkg.intervalMaxSeconds),
    displayOrder: String(pkg.displayOrder),
    active: pkg.active,
  };
}

function packageInput(form: PackageForm): Required<PackageInput> | null {
  const numericFields = [
    form.priceIdr,
    form.durationDays,
    form.maxTargetsPerMinute,
    form.maxAccounts,
    form.intervalMinSeconds,
    form.intervalMaxSeconds,
    form.displayOrder,
  ].map(Number);
  if (!form.code.trim() || !form.name.trim() || numericFields.some((value) => !Number.isInteger(value) || value < 0)) return null;
  const [priceIdr, durationDays, maxTargetsPerMinute, maxAccounts, intervalMinSeconds, intervalMaxSeconds, displayOrder] = numericFields;
  if (durationDays <= 0 || maxTargetsPerMinute <= 0 || maxAccounts <= 0 || intervalMinSeconds > intervalMaxSeconds) return null;
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    type: form.type,
    priceIdr,
    durationDays,
    features: form.type === "USERBOT" ? ["JASEB", "AUTO_COMMENT_MF"] : ["JASEB"],
    maxTargetsPerMinute,
    maxAccounts,
    intervalMinSeconds,
    intervalMaxSeconds,
    displayOrder,
    active: form.active,
  };
}

function AdminTopbar() {
  return (
    <header className="topbar">
      <div className="wordmark"><span className="wordmark-dot" aria-hidden="true" />kertaaji</div>
      <div className="topbar-meta"><span className="live-pill"><span aria-hidden="true" />Admin</span><span className="user-label">Panel operasional</span></div>
    </header>
  );
}

function WorkerCard({ worker, token, onSaved, onError }: { worker: WorkerAccount; token: string; onSaved: (worker: WorkerAccount) => void; onError: (error: unknown) => void }) {
  const [interval, setInterval] = useState(String(worker.intervalSeconds ?? 60));
  const [active, setActive] = useState(worker.active ?? false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setInterval(String(worker.intervalSeconds ?? 60));
    setActive(worker.active ?? false);
  }, [worker]);

  const save = async () => {
    const intervalSeconds = Number(interval);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0) {
      onError(new ApiError(422, "INVALID_WORKER_ACCOUNT_SETTING"));
      return;
    }
    setSaving(true);
    try { onSaved(await updateWorkerAccount(token, worker.id, { intervalSeconds, active })); }
    catch (error) { onError(error); }
    finally { setSaving(false); }
  };

  return (
    <article className="admin-card">
      <div className="admin-card__head"><div><p className="admin-card__label">Akun worker</p><h3>{worker.label}</h3></div><span className={`admin-badge admin-badge--${worker.availability.toLowerCase()}`}>{worker.availability.replaceAll("_", " ")}</span></div>
      <div className="admin-meta"><span>Status Telegram</span><strong>{worker.accountStatus}</strong><span>Interval</span><strong>{worker.intervalSeconds === null ? "Belum diatur" : `${worker.intervalSeconds} detik`}</strong></div>
      <div className="worker-controls">
        <label>Interval detik<input inputMode="numeric" value={interval} onChange={(event) => setInterval(event.target.value)} /></label>
        <label className="check-control"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Aktif</label>
        <button className="button button--soft" type="button" onClick={() => void save()} disabled={saving}>{saving ? "Menyimpan" : "Simpan"}</button>
      </div>
    </article>
  );
}

function PackageDialog({ current, token, onClose, onSaved, onError }: { current: ServicePackage | null; token: string; onClose: () => void; onSaved: (pkg: ServicePackage) => void; onError: (error: unknown) => void }) {
  const [form, setForm] = useState<PackageForm>(() => packageForm(current));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const field = <K extends keyof PackageForm>(key: K, value: PackageForm[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = packageInput(form);
    if (!value) { setFormError("Periksa nama, kode, dan angka paket."); return; }
    setBusy(true); setFormError(null);
    try {
      const saved = current
        ? await updateAdminPackage(token, current.id, (({ code: _code, ...input }) => input)(value))
        : await createAdminPackage(token, value);
      onSaved(saved); onClose();
    } catch (error) {
      setFormError(errorLabel(error)); onError(error);
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-layer" role="presentation">
      <div className="modal-backdrop" onClick={onClose} />
      <section className="modal-card modal-card--admin" role="dialog" aria-modal="true" aria-labelledby="package-title">
        <div className="modal-head"><div><p className="eyebrow">Paket</p><h2 id="package-title">{current ? "Ubah paket" : "Paket baru"}</h2></div><button className="close-button" type="button" onClick={onClose}>Tutup</button></div>
        <form className="stack-form package-form" onSubmit={save}>
          <label>Kode<input value={form.code} onChange={(event) => field("code", event.target.value)} disabled={current !== null} required /></label>
          <label>Nama<input value={form.name} onChange={(event) => field("name", event.target.value)} required /></label>
          <label>Jenis<select value={form.type} onChange={(event) => field("type", event.target.value as ServicePackage["type"])}><option value="USERBOT">Userbot</option><option value="JASEB_WORKER">Jaseb Worker</option></select></label>
          <div className="form-grid"><label>Harga<input inputMode="numeric" value={form.priceIdr} onChange={(event) => field("priceIdr", event.target.value)} required /></label><label>Masa aktif hari<input inputMode="numeric" value={form.durationDays} onChange={(event) => field("durationDays", event.target.value)} required /></label></div>
          <div className="form-grid"><label>Batas target per menit<input inputMode="numeric" value={form.maxTargetsPerMinute} onChange={(event) => field("maxTargetsPerMinute", event.target.value)} required /></label><label>Jumlah akun<input inputMode="numeric" value={form.maxAccounts} onChange={(event) => field("maxAccounts", event.target.value)} required /></label></div>
          <div className="form-grid"><label>Interval minimum<input inputMode="numeric" value={form.intervalMinSeconds} onChange={(event) => field("intervalMinSeconds", event.target.value)} required /></label><label>Interval maksimum<input inputMode="numeric" value={form.intervalMaxSeconds} onChange={(event) => field("intervalMaxSeconds", event.target.value)} required /></label></div>
          <label>Urutan tampil<input inputMode="numeric" value={form.displayOrder} onChange={(event) => field("displayOrder", event.target.value)} required /></label>
          <label className="check-control"><input type="checkbox" checked={form.active} onChange={(event) => field("active", event.target.checked)} />Paket aktif</label>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? "Menyimpan" : "Simpan paket"}</button>
        </form>
      </section>
    </div>
  );
}

function UserAccess({ user, packages, token, onError }: { user: AdminUser; packages: readonly ServicePackage[]; token: string; onError: (error: unknown) => void }) {
  const [entitlements, setEntitlements] = useState<readonly Entitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [packageId, setPackageId] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [maxLpmGroups, setMaxLpmGroups] = useState("1");
  const [maxChannelTargets, setMaxChannelTargets] = useState("1");
  const [extensionDays, setExtensionDays] = useState("30");
  const [busy, setBusy] = useState<string | null>(null);
  const available = useMemo(() => packages.filter((pkg) => pkg.active), [packages]);
  const selected = useMemo(() => available.find((pkg) => pkg.id === packageId) ?? available[0] ?? null, [available, packageId]);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setEntitlements(await listEntitlements(token, user.id)); }
    catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [onError, token, user.id]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!selected) { setPackageId(""); return; }
    setPackageId(selected.id);
    setDurationDays(String(selected.durationDays));
    setMaxLpmGroups(String(selected.maxTargetsPerMinute));
    setMaxChannelTargets(String(selected.maxTargetsPerMinute));
  }, [selected]);

  const grant = async () => {
    if (!selected) return;
    const duration = Number(durationDays);
    const lpmGroups = Number(maxLpmGroups);
    const channelTargets = Number(maxChannelTargets);
    if (!Number.isInteger(duration) || duration <= 0 || !Number.isInteger(lpmGroups) || lpmGroups < 0 || !Number.isInteger(channelTargets) || channelTargets < 0) { onError(new ApiError(422, "INVALID_ENTITLEMENT")); return; }
    setBusy("grant");
    try {
      await grantEntitlement(token, user.id, { packageId: selected.id, durationDays: duration, maxLpmGroups: lpmGroups, maxChannelTargets: channelTargets });
      await reload();
    } catch (error) { onError(error); }
    finally { setBusy(null); }
  };

  const extend = async (entitlement: Entitlement) => {
    const days = Number(extensionDays);
    if (!Number.isInteger(days) || days <= 0) { onError(new ApiError(422, "INVALID_ENTITLEMENT")); return; }
    setBusy(entitlement.id);
    try { await extendEntitlement(token, entitlement.id, days); await reload(); }
    catch (error) { onError(error); }
    finally { setBusy(null); }
  };

  const revoke = async (entitlement: Entitlement) => {
    setBusy(entitlement.id);
    try { await revokeEntitlement(token, entitlement.id); await reload(); }
    catch (error) { onError(error); }
    finally { setBusy(null); }
  };

  return (
    <section className="admin-detail" aria-label={`Akses ${userName(user)}`}>
      <div className="admin-detail__head"><div><p className="eyebrow">Pengguna terpilih</p><h2>{user.firstName}</h2><p>{user.username ? `@${user.username}` : `ID Telegram ${user.telegramUserId}`}</p></div>{user.isAdmin && <span className="admin-badge">Admin</span>}</div>
      <div className="grant-form">
        <select value={selected?.id ?? ""} onChange={(event) => setPackageId(event.target.value)} disabled={available.length === 0}>{available.length === 0 ? <option>Tidak ada paket aktif</option> : available.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name}</option>)}</select>
        <label>Hari<input inputMode="numeric" value={durationDays} onChange={(event) => setDurationDays(event.target.value)} /></label>
        <label>Grup LPM<input inputMode="numeric" value={maxLpmGroups} onChange={(event) => setMaxLpmGroups(event.target.value)} /></label>
        <label>Target channel<input inputMode="numeric" value={maxChannelTargets} onChange={(event) => setMaxChannelTargets(event.target.value)} /></label>
        <button className="button button--primary" type="button" onClick={() => void grant()} disabled={!selected || busy !== null}>{busy === "grant" ? "Menambah" : "Tambah akses"}</button>
      </div>
      {loading ? <p className="admin-muted">Memuat akses pengguna.</p> : entitlements.length === 0 ? <p className="admin-muted">Belum ada akses untuk pengguna ini.</p> : (
        <div className="entitlement-list">{entitlements.map((entitlement) => (
          <article key={entitlement.id} className="entitlement-row"><div><strong>{entitlement.packageType === "USERBOT" ? "Userbot" : "Jaseb Worker"}</strong><span>{entitlement.status} sampai {formatDate(entitlement.expiresAt)}</span></div><div className="entitlement-actions"><label>Tambah hari<input inputMode="numeric" value={extensionDays} onChange={(event) => setExtensionDays(event.target.value)} /></label><button className="button button--ghost" type="button" onClick={() => void extend(entitlement)} disabled={busy !== null}>Perpanjang</button><button className="button button--danger-ghost" type="button" onClick={() => void revoke(entitlement)} disabled={busy !== null}>Cabut</button></div></article>
        ))}</div>
      )}
    </section>
  );
}

export function AdminPanel({ token, onSessionExpired }: { token: string; onSessionExpired: () => void }) {
  const [section, setSection] = useState<AdminSection>("USERS");
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [packages, setPackages] = useState<readonly ServicePackage[]>([]);
  const [workers, setWorkers] = useState<readonly WorkerAccount[]>([]);
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [editingPackage, setEditingPackage] = useState<ServicePackage | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.code === "ADMIN_REQUIRED")) { onSessionExpired(); return; }
    setPageError(errorLabel(error));
  }, [onSessionExpired]);

  const loadAll = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const [nextUsers, nextPackages, nextWorkers] = await Promise.all([
        listAdminUsers(token), listAdminPackages(token), listWorkerAccounts(token),
      ]);
      setUsers(nextUsers); setPackages(nextPackages); setWorkers(nextWorkers);
    } catch (error) { handleError(error); }
    finally { setLoading(false); }
  }, [handleError, token]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const searchUsers = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoading(true); setPageError(null);
    try { setUsers(await listAdminUsers(token, query)); setSelectedUser(null); }
    catch (error) { handleError(error); }
    finally { setLoading(false); }
  };

  const replacePackage = (next: ServicePackage) => {
    setPackages((previous) => {
      const exists = previous.some((pkg) => pkg.id === next.id);
      return exists ? previous.map((pkg) => pkg.id === next.id ? next : pkg) : [...previous, next];
    });
  };

  const replaceWorker = (next: WorkerAccount) => setWorkers((previous) => previous.map((worker) => worker.id === next.id ? next : worker));

  return (
    <main className="page page--admin">
      <AdminTopbar />
      <section className="admin-hero"><div><p className="eyebrow">Admin</p><h1>Kelola <em>Kertaaji.</em></h1><p>Pengguna, paket, dan akun worker.</p></div><button className="button button--ghost" type="button" onClick={() => void loadAll()} disabled={loading}>{loading ? "Memuat" : "Muat ulang"}</button></section>
      <nav className="admin-tabs" aria-label="Menu admin"><button className={section === "USERS" ? "active" : ""} type="button" onClick={() => setSection("USERS")}>Pengguna</button><button className={section === "PACKAGES" ? "active" : ""} type="button" onClick={() => setSection("PACKAGES")}>Paket</button><button className={section === "WORKERS" ? "active" : ""} type="button" onClick={() => setSection("WORKERS")}>Akun worker</button></nav>
      {pageError && <div className="notice notice--error" role="alert"><span>{pageError}</span><button className="text-button" type="button" onClick={() => setPageError(null)}>Tutup</button></div>}
      {section === "USERS" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Pengguna</p><h2>Daftar pengguna</h2></div><form className="admin-search" onSubmit={searchUsers}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nama, username, atau ID Telegram" /><button className="button button--soft" type="submit" disabled={loading}>Cari</button></form></div><div className="admin-user-layout"><div className="admin-list">{loading ? <p className="admin-muted">Memuat pengguna.</p> : users.length === 0 ? <p className="admin-muted">Tidak ada pengguna.</p> : users.map((user) => <button className={`admin-user-row ${selectedUser?.id === user.id ? "selected" : ""}`} type="button" key={user.id} onClick={() => setSelectedUser(user)}><span><strong>{user.firstName}</strong><small>{userName(user)}</small></span><span>{user.isAdmin ? "Admin" : formatDate(user.lastAuthenticatedAt)}</span></button>)}</div>{selectedUser ? <UserAccess user={selectedUser} packages={packages} token={token} onError={handleError} /> : <div className="admin-detail admin-detail--placeholder"><p>Pilih pengguna untuk mengatur aksesnya.</p></div>}</div></section>}
      {section === "PACKAGES" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Paket</p><h2>Paket layanan</h2></div><button className="button button--primary" type="button" onClick={() => setEditingPackage(null)}>Paket baru</button></div><div className="admin-card-grid">{loading ? <p className="admin-muted">Memuat paket.</p> : packages.length === 0 ? <p className="admin-muted">Belum ada paket.</p> : packages.map((pkg) => <article className="admin-card" key={pkg.id}><div className="admin-card__head"><div><p className="admin-card__label">{pkg.type === "USERBOT" ? "Userbot" : "Jaseb Worker"}</p><h3>{pkg.name}</h3></div><span className={`admin-badge ${pkg.active ? "" : "admin-badge--disabled"}`}>{pkg.active ? "Aktif" : "Nonaktif"}</span></div><div className="admin-meta"><span>Harga</span><strong>{formatRupiah(pkg.priceIdr)}</strong><span>Masa aktif</span><strong>{pkg.durationDays} hari</strong><span>Jumlah akun</span><strong>{pkg.maxAccounts}</strong></div><button className="button button--ghost" type="button" onClick={() => setEditingPackage(pkg)}>Ubah paket</button></article>)}</div></section>}
      {section === "WORKERS" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Akun worker</p><h2>Pengaturan worker</h2></div></div><div className="admin-card-grid">{loading ? <p className="admin-muted">Memuat akun worker.</p> : workers.length === 0 ? <p className="admin-muted">Belum ada akun worker.</p> : workers.map((worker) => <WorkerCard key={worker.id} worker={worker} token={token} onSaved={replaceWorker} onError={handleError} />)}</div></section>}
      {editingPackage !== undefined && <PackageDialog current={editingPackage} token={token} onClose={() => setEditingPackage(undefined)} onSaved={replacePackage} onError={handleError} />}
    </main>
  );
}
