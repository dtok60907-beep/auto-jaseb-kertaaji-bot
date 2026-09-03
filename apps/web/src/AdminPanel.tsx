import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  admitCanaryUser,
  ApiError,
  createAdminBroadcastCampaign,
  createAdminBroadcastLpmTarget,
  createAdminForwardBroadcastMaterial,
  createAdminPackage,
  createAdminTextBroadcastMaterial,
  extendEntitlement,
  getAdminBroadcastSettings,
  getCurrentAdminBroadcastCampaign,
  grantEntitlement,
  listAdminPackages,
  listAdminUsers,
  listCanaryAdmissions,
  listEntitlements,
  listWorkerAccounts,
  revokeCanaryUser,
  revokeEntitlement,
  stopAdminBroadcastCampaign,
  updateAdminBroadcastLpmTarget,
  updateAdminForwardBroadcastMaterial,
  updateAdminPackage,
  updateAdminTextBroadcastMaterial,
  updateWorkerAccount,
} from "./api";
import type { AdminUser, BroadcastCampaign, BroadcastLpmTarget, BroadcastMaterial, CanaryAdmission, Entitlement, PackageInput, ServicePackage, WorkerAccount } from "./types";

const ADMIN_JASEB_MIN_REPEAT_MINUTES = 5;
const CANARY_SLOT_LIMIT = 15;
const PACKAGE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

type AdminSection = "USERS" | "ADMISSIONS" | "PACKAGES" | "WORKERS";

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
  SUBSCRIPTION_REQUIRED: "Pengguna ini belum punya paket Jasa Sebar aktif.",
  SUBSCRIPTION_EXPIRED: "Paket Jasa Sebar pengguna ini sudah berakhir.",
  INVALID_BROADCAST_MATERIAL: "Materi belum valid. Periksa lagi link atau wording-nya.",
  BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE: "Materi belum tersedia. Buat materi baru dulu.",
  LPM_TARGET_NOT_FOUND_OR_INACTIVE: "Target belum tersedia. Buat target baru dulu.",
  USERBOT_NOT_CONNECTED: "Akun Telegram pengguna belum tersambung.",
  WORKER_UNAVAILABLE: "Belum ada akun worker yang tersedia.",
  LPM_GROUP_LIMIT_REACHED: "Batas jumlah target Grup LPM paket pengguna ini sudah tercapai.",
  LPM_TARGET_EXISTS: "Target itu sudah ditambahkan sebelumnya.",
  CAMPAIGN_ALREADY_ACTIVE: "Sudah ada Jasa Sebar berulang yang sedang berjalan untuk pengguna ini.",
  INTERVAL_TOO_SHORT: `Jeda pengulangan minimal ${ADMIN_JASEB_MIN_REPEAT_MINUTES} menit.`,
  INVALID_TELEGRAM_USER_ID: "ID Telegram belum sesuai. Pastikan cuma angka.",
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
    if (!current && !PACKAGE_CODE_PATTERN.test(form.code.trim())) {
      setFormError("Kode cuma boleh huruf kecil, angka, strip (-), atau underscore (_), tanpa spasi. Contoh: jaseb-otomatis-harian.");
      return;
    }
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
          <label>Kode<input value={form.code} onChange={(event) => field("code", event.target.value)} placeholder="jaseb-otomatis-harian" disabled={current !== null} required /></label>
          {!current && <p className="helper-text">ID unik paket ini, bukan nama tampilan. Huruf kecil, angka, strip/underscore saja, tanpa spasi -- ga bisa diubah lagi setelah disimpan.</p>}
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

function UserJasebPanel({ user, token, onError }: { user: AdminUser; token: string; onError: (error: unknown) => void }) {
  const [loading, setLoading] = useState(true);
  const [material, setMaterial] = useState<BroadcastMaterial | null>(null);
  const [target, setTarget] = useState<BroadcastLpmTarget | null>(null);
  const [accountMode, setAccountMode] = useState<"JASEB_WORKER" | "USERBOT" | null>(null);
  const [campaign, setCampaign] = useState<BroadcastCampaign | null>(null);

  const [editingMaterial, setEditingMaterial] = useState(false);
  const [materialKind, setMaterialKind] = useState<"TEXT" | "FORWARD">("TEXT");
  const [materialText, setMaterialText] = useState("");
  const [forwardLink, setForwardLink] = useState("");
  const [forwardShowSource, setForwardShowSource] = useState(true);
  const [savingMaterial, setSavingMaterial] = useState(false);

  const [editingTarget, setEditingTarget] = useState(false);
  const [targetRef, setTargetRef] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [savingTarget, setSavingTarget] = useState(false);

  const [repeatFormOpen, setRepeatFormOpen] = useState(false);
  const [repeatMinutes, setRepeatMinutes] = useState(String(ADMIN_JASEB_MIN_REPEAT_MINUTES));
  const [savingCampaign, setSavingCampaign] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, current] = await Promise.all([
        getAdminBroadcastSettings(token, user.id),
        getCurrentAdminBroadcastCampaign(token, user.id),
      ]);
      setMaterial(settings.materials.find((item) => item.active) ?? null);
      setTarget(settings.lpmTargets.find((item) => item.active) ?? null);
      setAccountMode(settings.accountMode);
      setCampaign(current);
    } catch (error) { onError(error); }
    finally { setLoading(false); }
  }, [onError, token, user.id]);

  useEffect(() => { void reload(); }, [reload]);

  const openMaterialEditor = () => {
    if (material?.kind === "TEXT") { setMaterialKind("TEXT"); setMaterialText(material.text); }
    else if (material?.kind === "FORWARD") { setMaterialKind("FORWARD"); setForwardLink(material.source.canonicalLink); setForwardShowSource(material.sourceAttribution === "SHOW_SOURCE"); }
    else { setMaterialKind("TEXT"); setMaterialText(""); setForwardLink(""); setForwardShowSource(true); }
    setEditingMaterial(true);
  };

  const saveMaterial = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingMaterial(true);
    try {
      const saved = materialKind === "TEXT"
        ? material
          ? await updateAdminTextBroadcastMaterial(token, user.id, material.id, materialText.trim())
          : await createAdminTextBroadcastMaterial(token, user.id, materialText.trim())
        : material
          ? await updateAdminForwardBroadcastMaterial(token, user.id, material.id, forwardLink.trim(), forwardShowSource ? "SHOW_SOURCE" : "HIDE_SOURCE")
          : await createAdminForwardBroadcastMaterial(token, user.id, forwardLink.trim(), forwardShowSource ? "SHOW_SOURCE" : "HIDE_SOURCE");
      setMaterial(saved);
      setEditingMaterial(false);
    } catch (error) { onError(error); }
    finally { setSavingMaterial(false); }
  };

  const openTargetEditor = () => {
    setTargetRef(target?.telegramTargetRef ?? "");
    setTargetLabel(target?.label ?? "");
    setEditingTarget(true);
  };

  const saveTarget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingTarget(true);
    const input = { telegramTargetRef: targetRef.trim(), label: targetLabel.trim() || null };
    try {
      const saved = target
        ? await updateAdminBroadcastLpmTarget(token, user.id, target.id, input)
        : await createAdminBroadcastLpmTarget(token, user.id, input);
      setTarget(saved);
      setEditingTarget(false);
    } catch (error) { onError(error); }
    finally { setSavingTarget(false); }
  };

  const openIntervalEditor = () => {
    setRepeatMinutes(String(campaign ? Math.round(campaign.intervalSeconds / 60) : ADMIN_JASEB_MIN_REPEAT_MINUTES));
    setRepeatFormOpen(true);
  };

  const saveCampaign = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!material || !target || !accountMode) return;
    const minutes = Number(repeatMinutes);
    setSavingCampaign(true);
    try {
      if (campaign?.status === "ACTIVE") await stopAdminBroadcastCampaign(token, user.id, campaign.id);
      const created = await createAdminBroadcastCampaign(token, user.id, {
        accountMode, materialId: material.id, targetIds: [target.id], intervalSeconds: minutes * 60,
      });
      setCampaign(created);
      setRepeatFormOpen(false);
    } catch (error) { onError(error); }
    finally { setSavingCampaign(false); }
  };

  const stopCampaign = async () => {
    if (!campaign) return;
    setSavingCampaign(true);
    try {
      await stopAdminBroadcastCampaign(token, user.id, campaign.id);
      setCampaign(await getCurrentAdminBroadcastCampaign(token, user.id));
    } catch (error) { onError(error); }
    finally { setSavingCampaign(false); }
  };

  if (loading) return <section className="admin-detail"><p className="admin-muted">Memuat Jasa Sebar.</p></section>;

  return (
    <section className="admin-detail" aria-label={`Jasa Sebar ${userName(user)}`}>
      <div className="admin-detail__head"><h3>Jasa Sebar</h3></div>

      {accountMode === null && <p className="admin-muted">Belum ada paket Jasa Sebar aktif untuk pengguna ini.</p>}

      {accountMode !== null && (!material || editingMaterial) && (
        <form className="stack-form" onSubmit={saveMaterial}>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => setMaterialKind("TEXT")} disabled={materialKind === "TEXT"}>Wording</button>
            <button className="button button--ghost" type="button" onClick={() => setMaterialKind("FORWARD")} disabled={materialKind === "FORWARD"}>Forward</button>
          </div>
          {materialKind === "TEXT" ? (
            <>
              <label htmlFor={`admin-jaseb-text-${user.id}`}>Materi wording</label>
              <textarea id={`admin-jaseb-text-${user.id}`} rows={3} maxLength={4096} value={materialText} onChange={(event) => setMaterialText(event.target.value)} required />
            </>
          ) : (
            <>
              <label htmlFor={`admin-jaseb-link-${user.id}`}>Link post yang akan di-forward</label>
              <input id={`admin-jaseb-link-${user.id}`} value={forwardLink} onChange={(event) => setForwardLink(event.target.value)} placeholder="https://t.me/nama_channel/123" required />
              <label htmlFor={`admin-jaseb-source-${user.id}`}><input id={`admin-jaseb-source-${user.id}`} type="checkbox" checked={forwardShowSource} onChange={(event) => setForwardShowSource(event.target.checked)} /> Tampilkan sumber</label>
            </>
          )}
          <div className="account-card__actions">
            {editingMaterial && <button className="button button--ghost" type="button" onClick={() => setEditingMaterial(false)} disabled={savingMaterial}>Batal</button>}
            <button className="button button--primary" type="submit" disabled={savingMaterial || (materialKind === "TEXT" ? !materialText.trim() : !forwardLink.trim())}>{savingMaterial ? "Menyimpan" : "Simpan materi"}</button>
          </div>
        </form>
      )}

      {material && !editingMaterial && (!target || editingTarget) && (
        <form className="stack-form" onSubmit={saveTarget}>
          <label htmlFor={`admin-jaseb-target-${user.id}`}>Target Grup LPM</label>
          <input id={`admin-jaseb-target-${user.id}`} value={targetRef} onChange={(event) => setTargetRef(event.target.value)} placeholder="@nama_grup atau https://t.me/nama_grup" required />
          <label htmlFor={`admin-jaseb-target-label-${user.id}`}>Label (opsional)</label>
          <input id={`admin-jaseb-target-label-${user.id}`} value={targetLabel} onChange={(event) => setTargetLabel(event.target.value)} />
          <div className="account-card__actions">
            {editingTarget && <button className="button button--ghost" type="button" onClick={() => setEditingTarget(false)} disabled={savingTarget}>Batal</button>}
            <button className="button button--primary" type="submit" disabled={savingTarget || !targetRef.trim()}>{savingTarget ? "Menyimpan" : "Simpan target"}</button>
          </div>
        </form>
      )}

      {material && target && !editingMaterial && !editingTarget && (
        <>
          <p className="admin-muted">
            Materi: {material.kind === "TEXT" ? `"${material.text.slice(0, 60)}${material.text.length > 60 ? "..." : ""}"` : `forward dari ${material.source.canonicalLink}`}
            {" · "}Target: {target.label ?? target.telegramTargetRef}
          </p>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={openMaterialEditor}>Ganti Materi</button>
            <button className="button button--ghost" type="button" onClick={openTargetEditor}>Ganti Target</button>
          </div>

          {campaign?.status === "ACTIVE" && !repeatFormOpen ? (
            <div className="account-card__actions">
              <span className="admin-muted">Otomatis tiap {Math.round(campaign.intervalSeconds / 60)} menit{campaign.lastCycleAt ? `, terakhir ${formatDate(campaign.lastCycleAt)}` : ""}.</span>
              <button className="button button--ghost" type="button" onClick={openIntervalEditor} disabled={savingCampaign}>Ubah Jeda</button>
              <button className="button button--danger-ghost" type="button" onClick={() => void stopCampaign()} disabled={savingCampaign}>{savingCampaign ? "Menghentikan" : "Hentikan"}</button>
            </div>
          ) : !repeatFormOpen ? (
            <div className="account-card__actions">
              <button className="button button--primary" type="button" onClick={() => { setRepeatMinutes(String(ADMIN_JASEB_MIN_REPEAT_MINUTES)); setRepeatFormOpen(true); }}>Nyalakan Sebar Otomatis</button>
            </div>
          ) : (
            <form className="stack-form" onSubmit={saveCampaign}>
              <label htmlFor={`admin-jaseb-minutes-${user.id}`}>Ulangi tiap berapa menit</label>
              <input id={`admin-jaseb-minutes-${user.id}`} type="number" inputMode="numeric" min={ADMIN_JASEB_MIN_REPEAT_MINUTES} value={repeatMinutes} onChange={(event) => setRepeatMinutes(event.target.value)} required />
              <div className="account-card__actions">
                <button className="button button--ghost" type="button" onClick={() => setRepeatFormOpen(false)} disabled={savingCampaign}>Batal</button>
                <button className="button button--primary" type="submit" disabled={savingCampaign || Number(repeatMinutes) < ADMIN_JASEB_MIN_REPEAT_MINUTES}>{savingCampaign ? "Menyimpan" : campaign ? "Simpan Jeda" : "Mulai"}</button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
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
      <UserJasebPanel key={user.id} user={user} token={token} onError={onError} />
    </section>
  );
}

export function AdminPanel({ token, onSessionExpired }: { token: string; onSessionExpired: () => void }) {
  const [section, setSection] = useState<AdminSection>("USERS");
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [admissions, setAdmissions] = useState<readonly CanaryAdmission[]>([]);
  const [packages, setPackages] = useState<readonly ServicePackage[]>([]);
  const [workers, setWorkers] = useState<readonly WorkerAccount[]>([]);
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [editingPackage, setEditingPackage] = useState<ServicePackage | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [newTelegramUserId, setNewTelegramUserId] = useState("");
  const [admissionBusy, setAdmissionBusy] = useState<string | null>(null);
  const [admissionNotice, setAdmissionNotice] = useState<string | null>(null);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && (error.status === 401 || error.code === "ADMIN_REQUIRED")) { onSessionExpired(); return; }
    setPageError(errorLabel(error));
  }, [onSessionExpired]);

  const loadAll = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const [nextUsers, nextPackages, nextWorkers, nextAdmissions] = await Promise.all([
        listAdminUsers(token), listAdminPackages(token), listWorkerAccounts(token), listCanaryAdmissions(token),
      ]);
      setUsers(nextUsers); setPackages(nextPackages); setWorkers(nextWorkers); setAdmissions(nextAdmissions);
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

  const admitUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const telegramUserId = newTelegramUserId.trim();
    if (!telegramUserId) return;
    setAdmissionBusy("add"); setPageError(null); setAdmissionNotice(null);
    try {
      const result = await admitCanaryUser(token, telegramUserId);
      if (result.status === "LIMIT_REACHED") {
        setAdmissionNotice(`Slot canary sudah penuh (${CANARY_SLOT_LIMIT}/${CANARY_SLOT_LIMIT}). Cabut salah satu dulu sebelum menambah user baru.`);
      } else {
        setAdmissionNotice(result.status === "ALREADY_ADMITTED" ? `ID ${telegramUserId} sudah aktif sebelumnya.` : `ID ${telegramUserId} berhasil ditambahkan (slot ${result.slot}).`);
        setNewTelegramUserId("");
        await loadAll();
      }
    } catch (error) { handleError(error); }
    finally { setAdmissionBusy(null); }
  };

  const revokeUser = (telegramUserId: string) => async () => {
    setAdmissionBusy(telegramUserId); setPageError(null); setAdmissionNotice(null);
    try { await revokeCanaryUser(token, telegramUserId); await loadAll(); }
    catch (error) { handleError(error); }
    finally { setAdmissionBusy(null); }
  };

  return (
    <main className="page page--admin">
      <AdminTopbar />
      <section className="admin-hero"><div><p className="eyebrow">Admin</p><h1>Kelola <em>Kertaaji.</em></h1><p>Pengguna, paket, dan akun worker.</p></div><button className="button button--ghost" type="button" onClick={() => void loadAll()} disabled={loading}>{loading ? "Memuat" : "Muat ulang"}</button></section>
      <nav className="admin-tabs" aria-label="Menu admin"><button className={section === "USERS" ? "active" : ""} type="button" onClick={() => setSection("USERS")}>Pengguna</button><button className={section === "ADMISSIONS" ? "active" : ""} type="button" onClick={() => setSection("ADMISSIONS")}>Akses masuk</button><button className={section === "PACKAGES" ? "active" : ""} type="button" onClick={() => setSection("PACKAGES")}>Paket</button><button className={section === "WORKERS" ? "active" : ""} type="button" onClick={() => setSection("WORKERS")}>Akun worker</button></nav>
      {pageError && <div className="notice notice--error" role="alert"><span>{pageError}</span><button className="text-button" type="button" onClick={() => setPageError(null)}>Tutup</button></div>}
      {section === "USERS" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Pengguna</p><h2>Daftar pengguna</h2></div><form className="admin-search" onSubmit={searchUsers}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nama, username, atau ID Telegram" /><button className="button button--soft" type="submit" disabled={loading}>Cari</button></form></div><div className="admin-user-layout"><div className="admin-list">{loading ? <p className="admin-muted">Memuat pengguna.</p> : users.length === 0 ? <p className="admin-muted">Tidak ada pengguna.</p> : users.map((user) => <button className={`admin-user-row ${selectedUser?.id === user.id ? "selected" : ""}`} type="button" key={user.id} onClick={() => setSelectedUser(user)}><span><strong>{user.firstName}</strong><small>{userName(user)}</small></span><span>{user.isAdmin ? "Admin" : formatDate(user.lastAuthenticatedAt)}</span></button>)}</div>{selectedUser ? <UserAccess key={selectedUser.id} user={selectedUser} packages={packages} token={token} onError={handleError} /> : <div className="admin-detail admin-detail--placeholder"><p>Pilih pengguna untuk mengatur aksesnya.</p></div>}</div></section>}
      {section === "ADMISSIONS" && <section className="admin-section">
        <div className="section-heading"><div><p className="eyebrow">Akses masuk</p><h2>Slot canary ({admissions.filter((item) => item.revokedAt === null).length}/{CANARY_SLOT_LIMIT})</h2></div></div>
        <p className="admin-muted">Sebelum paket apapun berlaku, ID Telegram user harus di-admit dulu di sini. Batasnya {CANARY_SLOT_LIMIT} user aktif sekaligus.</p>
        <form className="admin-search" onSubmit={admitUser}>
          <input inputMode="numeric" value={newTelegramUserId} onChange={(event) => setNewTelegramUserId(event.target.value)} placeholder="ID Telegram, contoh: 8046200601" />
          <button className="button button--primary" type="submit" disabled={admissionBusy !== null || !newTelegramUserId.trim()}>{admissionBusy === "add" ? "Menambah" : "Tambahkan"}</button>
        </form>
        {admissionNotice && <div className="notice notice--info" role="status"><span>{admissionNotice}</span><button className="text-button" type="button" onClick={() => setAdmissionNotice(null)}>Tutup</button></div>}
        {loading ? <p className="admin-muted">Memuat daftar akses.</p> : admissions.length === 0 ? <p className="admin-muted">Belum ada user yang di-admit.</p> : (
          <div className="entitlement-list">{admissions.map((item) => (
            <article key={item.telegramUserId} className="entitlement-row">
              <div>
                <strong>{item.telegramUserId}</strong>
                <span>
                  {item.revokedAt ? "Akses dicabut" : `Slot ${item.slot} · sejak ${formatDate(item.admittedAt)}`}
                  {" · "}{item.appUserReady ? "sudah buka Mini App" : "belum pernah buka Mini App"}
                  {item.adminActive ? " · Admin" : ""}
                </span>
              </div>
              <div className="entitlement-actions">
                {!item.revokedAt && (
                  <button className="button button--danger-ghost" type="button" disabled={admissionBusy !== null} onClick={() => void revokeUser(item.telegramUserId)()}>
                    {admissionBusy === item.telegramUserId ? "Mencabut" : "Cabut akses"}
                  </button>
                )}
              </div>
            </article>
          ))}</div>
        )}
      </section>}
      {section === "PACKAGES" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Paket</p><h2>Paket layanan</h2></div><button className="button button--primary" type="button" onClick={() => setEditingPackage(null)}>Paket baru</button></div><div className="admin-card-grid">{loading ? <p className="admin-muted">Memuat paket.</p> : packages.length === 0 ? <p className="admin-muted">Belum ada paket.</p> : packages.map((pkg) => <article className="admin-card" key={pkg.id}><div className="admin-card__head"><div><p className="admin-card__label">{pkg.type === "USERBOT" ? "Userbot" : "Jaseb Worker"}</p><h3>{pkg.name}</h3></div><span className={`admin-badge ${pkg.active ? "" : "admin-badge--disabled"}`}>{pkg.active ? "Aktif" : "Nonaktif"}</span></div><div className="admin-meta"><span>Harga</span><strong>{formatRupiah(pkg.priceIdr)}</strong><span>Masa aktif</span><strong>{pkg.durationDays} hari</strong><span>Jumlah akun</span><strong>{pkg.maxAccounts}</strong></div><button className="button button--ghost" type="button" onClick={() => setEditingPackage(pkg)}>Ubah paket</button></article>)}</div></section>}
      {section === "WORKERS" && <section className="admin-section"><div className="section-heading"><div><p className="eyebrow">Akun worker</p><h2>Pengaturan worker</h2></div></div><div className="admin-card-grid">{loading ? <p className="admin-muted">Memuat akun worker.</p> : workers.length === 0 ? <p className="admin-muted">Belum ada akun worker.</p> : workers.map((worker) => <WorkerCard key={worker.id} worker={worker} token={token} onSaved={replaceWorker} onError={handleError} />)}</div></section>}
      {editingPackage !== undefined && <PackageDialog current={editingPackage} token={token} onClose={() => setEditingPackage(undefined)} onSaved={replacePackage} onError={handleError} />}
    </main>
  );
}
