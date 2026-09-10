import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  createBroadcastLpmTarget,
  createForwardBroadcastMaterial,
  createTextBroadcastMaterial,
  deleteBroadcastLpmTarget,
  getBroadcastHistory,
  getBroadcastOperation,
  getBroadcastSettings,
  getCurrentBroadcastCampaign,
  setBroadcastServiceEnabled,
  updateBroadcastLpmTarget,
  updateForwardBroadcastMaterial,
  updateTextBroadcastMaterial,
} from "./api";
import type { BroadcastCampaign, BroadcastHistoryEntry, BroadcastLpmTarget, BroadcastMaterial, BroadcastOperation } from "./types";
import { parseTargetInput } from "./target-input";

const OPERATION_TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED_FINAL", "CANCELLED", "SIDE_EFFECT_UNCERTAIN"]);
const MAX_TEXT_LENGTH = 4096;
const POLL_INTERVAL_MS = 2_000;
const CAMPAIGN_REFRESH_INTERVAL_MS = 15_000;
const MINIMUM_REPEAT_MINUTES = 5;
const HISTORY_PAGE_SIZE = 20;

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: "Menunggu giliran",
  SENDING: "Sedang dikirim",
  SUCCEEDED: "Berhasil terkirim",
  FAILED_RETRYABLE: "Gagal, dicoba lagi",
  FAILED_FINAL: "Gagal",
  SIDE_EFFECT_UNCERTAIN: "Status tidak pasti, perlu diperiksa",
  CANCELLED: "Dibatalkan",
};

const DELIVERY_ERROR_LABEL: Record<string, string> = {
  ADAPTER_NOT_READY: "Akun belum siap, coba lagi sebentar.",
  SESSION_REVOKED: "Sesi akun Telegram sudah dicabut. Hubungkan ulang akunnya.",
  SESSION_CONFLICT: "Akun sedang dipakai proses lain. Coba lagi.",
  FLOOD_WAIT: "Telegram minta jeda sebentar. Akan dicoba lagi otomatis.",
  TARGET_NOT_FOUND: "Target grup tidak ditemukan. Periksa lagi link atau username-nya.",
  SOURCE_NOT_FOUND: "Post sumber forward tidak ditemukan.",
  JOIN_APPROVAL_REQUIRED: "Perlu persetujuan admin grup buat gabung dulu.",
  JOIN_APPROVAL_PENDING: "Permintaan bergabung sudah dikirim dan masih menunggu persetujuan admin grup.",
  ACCOUNT_GROUP_LIMIT_REACHED: "Akun sudah kena batas jumlah grup dari Telegram.",
  CHAT_WRITE_FORBIDDEN: "Akun tidak diizinkan mengirim pesan di grup ini.",
  FORWARD_FORBIDDEN: "Post sumber tidak bisa di-forward — channel asalnya mengaktifkan proteksi konten. Pakai post lain atau materi wording manual.",
  SOURCE_ATTRIBUTION_UNSUPPORTED: "Pengaturan tampilkan/sembunyikan sumber tidak didukung untuk post ini.",
  TELEGRAM_TRANSIENT: "Telegram sedang bermasalah sementara. Akan dicoba lagi.",
  TELEGRAM_UNKNOWN: "Terjadi masalah tak terduga dari Telegram.",
  LPM_TARGET_NOT_GROUP: "Target itu channel, bukan grup. Jasa Sebar cuma bisa ke grup.",
};

function deliveryErrorLabel(code: string): string {
  return DELIVERY_ERROR_LABEL[code] ?? code;
}

const JASEB_ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi ke server sedang bermasalah. Coba lagi.",
  REQUEST_FAILED: "Permintaan belum berhasil. Coba lagi.",
  SUBSCRIPTION_REQUIRED: "Paket Jasa Sebar belum aktif di akun ini.",
  SUBSCRIPTION_EXPIRED: "Paket Jasa Sebar kamu sudah berakhir.",
  INVALID_BROADCAST_MATERIAL: "Materi belum valid. Periksa lagi link atau wording-nya.",
  BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE: "Materi belum tersedia. Buat materi baru dulu.",
  BROADCAST_BUSY: "Masih ada proses Jasa Sebar yang berjalan. Hentikan atau tunggu proses itu selesai.",
  LPM_TARGET_NOT_FOUND_OR_INACTIVE: "Target belum tersedia. Buat target baru dulu.",
  USERBOT_NOT_CONNECTED: "Akun Telegram belum tersambung. Hubungkan akun dulu.",
  WORKER_UNAVAILABLE: "Belum ada akun worker yang tersedia. Coba lagi nanti.",
  IDEMPOTENCY_KEY_CONFLICT: "Permintaan ini sudah pernah diproses.",
  LPM_GROUP_LIMIT_REACHED: "Batas jumlah target Grup LPM paket kamu sudah tercapai.",
  LPM_TARGET_EXISTS: "Target itu sudah kamu tambahkan sebelumnya.",
  CAMPAIGN_ALREADY_ACTIVE: "Sudah ada Jasa Sebar berulang yang sedang berjalan.",
  INTERVAL_TOO_SHORT: `Jeda pengulangan minimal ${MINIMUM_REPEAT_MINUTES} menit.`,
  TOO_MANY_CONSECUTIVE_FAILURES: "Dihentikan otomatis karena gagal terkirim 3 kali berturut-turut.",
};

function jasebErrorLabel(error: unknown): string {
  if (error instanceof ApiError) return JASEB_ERROR_LABEL[error.code] ?? "Permintaan belum berhasil. Coba lagi.";
  return "Permintaan belum berhasil. Coba lagi.";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

function materialSummary(material: BroadcastMaterial): string {
  if (material.kind === "TEXT") {
    return material.text.length > 60 ? `"${material.text.slice(0, 60)}..."` : `"${material.text}"`;
  }
  return `forward dari ${material.source.canonicalLink}`;
}

export function JasebPanel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [material, setMaterial] = useState<BroadcastMaterial | null>(null);
  const [targets, setTargets] = useState<readonly BroadcastLpmTarget[]>([]);
  const [accountMode, setAccountMode] = useState<"JASEB_WORKER" | "USERBOT" | null>(null);
  const [materialKindChoice, setMaterialKindChoice] = useState<"TEXT" | "FORWARD" | null>(null);
  const [editingMaterial, setEditingMaterial] = useState(false);
  const [materialText, setMaterialText] = useState("");
  const [forwardLink, setForwardLink] = useState("");
  const [forwardShowSource, setForwardShowSource] = useState(true);
  const [targetRef, setTargetRef] = useState("");
  const [targetFormOpen, setTargetFormOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<BroadcastLpmTarget | null>(null);
  const [creatingMaterial, setCreatingMaterial] = useState(false);
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetBusy, setTargetBusy] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<BroadcastCampaign | null>(null);
  const [campaignOperation, setCampaignOperation] = useState<BroadcastOperation | null>(null);
  const [dismissedStoppedCampaignId, setDismissedStoppedCampaignId] = useState<string | null>(null);
  const campaignOperationPollTimer = useRef<number | null>(null);
  const [repeatMinutes, setRepeatMinutes] = useState(String(MINIMUM_REPEAT_MINUTES));
  const [serviceBusy, setServiceBusy] = useState(false);

  const [history, setHistory] = useState<readonly BroadcastHistoryEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const [settings, currentCampaign, historyPage] = await Promise.all([
        getBroadcastSettings(token),
        getCurrentBroadcastCampaign(token),
        getBroadcastHistory(token),
      ]);
      setMaterial(settings.materials.find((item) => item.active) ?? null);
      setTargets(settings.lpmTargets.filter((item) => item.active));
      setAccountMode(settings.accountMode);
      setCampaign(currentCampaign);
      if (currentCampaign) setRepeatMinutes(String(Math.round(currentCampaign.intervalSeconds / 60)));
      setHistory(historyPage.entries);
      setHistoryCursor(historyPage.nextCursor);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  // Auto-repeat cycles are created by the engine scheduler, not by this page,
  // so the only way to see their outcome is polling whichever operation the
  // campaign most recently produced.
  useEffect(() => {
    if (campaignOperationPollTimer.current !== null) {
      window.clearTimeout(campaignOperationPollTimer.current);
      campaignOperationPollTimer.current = null;
    }
    const operationId = campaign?.lastOperationId ?? null;
    if (!operationId) { setCampaignOperation(null); return; }
    const tick = async () => {
      try {
        const current = await getBroadcastOperation(token, operationId);
        setCampaignOperation(current);
        if (!OPERATION_TERMINAL_STATUSES.has(current.status)) {
          campaignOperationPollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      } catch { /* transient; the next campaign refresh or lastOperationId change retries */ }
    };
    void tick();
    return () => {
      if (campaignOperationPollTimer.current !== null) {
        window.clearTimeout(campaignOperationPollTimer.current);
        campaignOperationPollTimer.current = null;
      }
    };
  }, [campaign?.lastOperationId, token]);

  // Cycles happen minutes apart, driven by the engine — refresh periodically
  // while a campaign is active so a new cycle or an auto-stop shows up here
  // without the user having to reload the page.
  useEffect(() => {
    if (campaign?.status !== "ACTIVE") return;
    const campaignId = campaign.id;
    const refresh = async () => {
      try {
        const current = await getCurrentBroadcastCampaign(token);
        if (current?.id === campaignId) setCampaign(current);
      } catch { /* transient; next tick retries */ }
    };
    const timer = window.setInterval(() => void refresh(), CAMPAIGN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [campaign?.id, campaign?.status, token]);

  const openMaterialEditor = () => {
    if (!material) return;
    if (material.kind === "TEXT") { setMaterialText(material.text); setForwardLink(""); setForwardShowSource(true); }
    else { setForwardLink(material.source.canonicalLink); setForwardShowSource(material.sourceAttribution === "SHOW_SOURCE"); setMaterialText(""); }
    setMaterialKindChoice(null);
    setEditingMaterial(true);
  };

  const cancelMaterialEdit = () => {
    setEditingMaterial(false);
    setMaterialKindChoice(null);
  };

  const submitMaterial = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingMaterial(true); setPageError(null);
    try {
      const saved = editingMaterial && material
        ? await updateTextBroadcastMaterial(token, material.id, materialText.trim())
        : await createTextBroadcastMaterial(token, materialText.trim());
      setMaterial(saved);
      setEditingMaterial(false);
      setMaterialKindChoice(null);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setCreatingMaterial(false); }
  };

  const submitForwardMaterial = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingMaterial(true); setPageError(null);
    try {
      const attribution = forwardShowSource ? "SHOW_SOURCE" : "HIDE_SOURCE";
      const saved = editingMaterial && material
        ? await updateForwardBroadcastMaterial(token, material.id, forwardLink.trim(), attribution)
        : await createForwardBroadcastMaterial(token, forwardLink.trim(), attribution);
      setMaterial(saved);
      setEditingMaterial(false);
      setMaterialKindChoice(null);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setCreatingMaterial(false); }
  };

  const openAddTarget = () => { setEditingTarget(null); setTargetRef(""); setTargetFormOpen(true); };
  const openEditTarget = (item: BroadcastLpmTarget) => { setEditingTarget(item); setTargetRef(item.telegramTargetRef); setTargetFormOpen(true); };
  const cancelTargetForm = () => { setTargetFormOpen(false); setEditingTarget(null); };

  const submitTarget = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingTarget(true); setPageError(null);
    const refs = editingTarget ? [targetRef.trim()] : [...parseTargetInput(targetRef)];
    if (refs.length === 0) { setSavingTarget(false); return; }
    try {
      const saved: BroadcastLpmTarget[] = [];
      if (editingTarget) {
        saved.push(await updateBroadcastLpmTarget(token, editingTarget.id, { telegramTargetRef: refs[0], label: null }));
      } else {
        for (const telegramTargetRef of refs) {
          saved.push(await createBroadcastLpmTarget(token, { telegramTargetRef, label: null }));
        }
      }
      setTargets((current) => saved.reduce<BroadcastLpmTarget[]>((next, item) => {
        const exists = next.some((target) => target.id === item.id);
        return exists ? next.map((target) => target.id === item.id ? item : target) : [...next, item];
      }, [...current]));
      setTargetRef("");
      setTargetFormOpen(false); setEditingTarget(null);
    } catch (cause) {
      const message = jasebErrorLabel(cause);
      await load();
      setPageError(message);
    }
    finally { setSavingTarget(false); }
  };

  const deleteTarget = async (item: BroadcastLpmTarget) => {
    setTargetBusy(item.id); setPageError(null);
    try {
      await deleteBroadcastLpmTarget(token, item.id);
      setTargets((current) => current.filter((existing) => existing.id !== item.id));
      setCampaign(await getCurrentBroadcastCampaign(token));
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setTargetBusy(null); }
  };

  const toggleService = async () => {
    if (serviceBusy || !accountMode) return;
    const enabled = campaign?.status === "ACTIVE";
    const minutes = Number(repeatMinutes);
    if (!enabled && (!material || targets.length === 0 || !Number.isInteger(minutes) || minutes < MINIMUM_REPEAT_MINUTES)) return;
    setServiceBusy(true); setPageError(null);
    try {
      const result = enabled
        ? await setBroadcastServiceEnabled(token, { enabled: false })
        : await setBroadcastServiceEnabled(token, {
          enabled: true,
          accountMode,
          materialId: material!.id,
          targetIds: targets.map((item) => item.id),
          intervalSeconds: minutes * 60,
        });
      setCampaign(result.campaign);
      if (!result.enabled) setCampaignOperation(null);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setServiceBusy(false); }
  };

  const loadMoreHistory = async () => {
    if (!historyCursor || loadingMoreHistory) return;
    setLoadingMoreHistory(true); setPageError(null);
    try {
      const page = await getBroadcastHistory(token, historyCursor);
      setHistory((current) => [...current, ...page.entries]);
      setHistoryCursor(page.nextCursor);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setLoadingMoreHistory(false); }
  };

  if (loading) {
    return (
      <section className="content-section" aria-labelledby="jaseb-heading">
        <div className="section-heading"><h2 id="jaseb-heading">Jasa Sebar</h2></div>
        <div className="account-grid" aria-busy="true"><div className="account-skeleton" /></div>
      </section>
    );
  }

  return (
    <section className="content-section" aria-labelledby="jaseb-heading">
      <div className="section-heading"><h2 id="jaseb-heading">Jasa Sebar</h2></div>
      {pageError && <div className="notice notice--error" role="alert"><span>{pageError}</span><button className="text-button" type="button" onClick={() => setPageError(null)}>Tutup</button></div>}

      {accountMode === null && (
        <div className="empty-card"><h3>Belum ada paket Jasa Sebar aktif</h3></div>
      )}

      {accountMode !== null && (
        <div className={`empty-card empty-card--status ${campaign?.status === "ACTIVE" ? "empty-card--active" : ""}`}>
          <div className="service-status-copy">
            <div className="status-card__title">
              <h3>Jasa Sebar</h3>
              <span className={`admin-badge ${campaign?.status === "ACTIVE" ? "" : "admin-badge--disabled"}`}>
                {campaign?.status === "ACTIVE" ? "Aktif" : "Nonaktif"}
              </span>
            </div>
            {campaign?.status === "ACTIVE" ? (
              <p>
                Berjalan tiap {Math.round(campaign.intervalSeconds / 60)} menit.
                {campaign.lastCycleAt ? ` Terakhir: ${formatDateTime(campaign.lastCycleAt)}.` : ""}
              </p>
            ) : material && targets.length > 0 ? (
              <label className="service-interval" htmlFor="jaseb-repeat-minutes">
                Jeda pengulangan
                <span>
                  <input
                    id="jaseb-repeat-minutes"
                    type="number"
                    inputMode="numeric"
                    min={MINIMUM_REPEAT_MINUTES}
                    value={repeatMinutes}
                    onChange={(event) => setRepeatMinutes(event.target.value)}
                    disabled={serviceBusy}
                  />
                  menit
                </span>
              </label>
            ) : (
              <p>Lengkapi materi dan minimal satu target grup untuk menyalakan service.</p>
            )}
          </div>
          <button
            className="service-switch"
            type="button"
            role="switch"
            aria-label="Jasa Sebar"
            aria-checked={campaign?.status === "ACTIVE"}
            onClick={() => void toggleService()}
            disabled={serviceBusy || (campaign?.status !== "ACTIVE" && (!material || targets.length === 0 || !Number.isInteger(Number(repeatMinutes)) || Number(repeatMinutes) < MINIMUM_REPEAT_MINUTES))}
          >
            <span className="service-switch__track"><span className="service-switch__thumb" /></span>
            <span className="service-switch__label">{serviceBusy ? "Menyimpan" : campaign?.status === "ACTIVE" ? "ON" : "OFF"}</span>
          </button>
        </div>
      )}

      {accountMode !== null && (!material || editingMaterial) && materialKindChoice === null && (
        <div className="empty-card">
          <div>
            <h3>Pilih materi Jasa Sebar</h3>
            <p>Tulis wording sendiri, atau forward dari post yang sudah ada pakai link-nya.</p>
          </div>
          <div className="account-card__actions">
            {editingMaterial && <button className="button button--ghost" type="button" onClick={cancelMaterialEdit}>Batal</button>}
            <button className="button button--ghost" type="button" onClick={() => setMaterialKindChoice("FORWARD")}>
              Forward dari Post
            </button>
            <button className="button button--primary" type="button" onClick={() => setMaterialKindChoice("TEXT")}>
              Tulis Wording
            </button>
          </div>
        </div>
      )}

      {accountMode !== null && (!material || editingMaterial) && materialKindChoice === "TEXT" && (
        <form className="stack-form" onSubmit={submitMaterial}>
          <label htmlFor="jaseb-material-text">Materi wording</label>
          <textarea
            id="jaseb-material-text"
            rows={4}
            maxLength={MAX_TEXT_LENGTH}
            value={materialText}
            onChange={(event) => setMaterialText(event.target.value)}
            placeholder="Tulis pesan yang akan disebar..."
            required
          />
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => (editingMaterial ? cancelMaterialEdit() : setMaterialKindChoice(null))} disabled={creatingMaterial}>Kembali</button>
            <button className="button button--primary" type="submit" disabled={creatingMaterial || !materialText.trim()}>
              {creatingMaterial ? "Menyimpan materi" : "Simpan materi"}
            </button>
          </div>
        </form>
      )}

      {accountMode !== null && (!material || editingMaterial) && materialKindChoice === "FORWARD" && (
        <form className="stack-form" onSubmit={submitForwardMaterial}>
          <label htmlFor="jaseb-forward-link">Link post yang akan di-forward</label>
          <input
            id="jaseb-forward-link"
            value={forwardLink}
            onChange={(event) => setForwardLink(event.target.value)}
            placeholder="https://t.me/nama_channel/123"
            required
          />
          <p className="helper-text">Link bubble chat dari post di channel publik. Bisa disalin dari menu "Salin Tautan Postingan" di Telegram.</p>
          <label htmlFor="jaseb-forward-show-source">
            <input
              id="jaseb-forward-show-source"
              type="checkbox"
              checked={forwardShowSource}
              onChange={(event) => setForwardShowSource(event.target.checked)}
            />{" "}
            Tampilkan sumber ("Diteruskan dari...")
          </label>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => (editingMaterial ? cancelMaterialEdit() : setMaterialKindChoice(null))} disabled={creatingMaterial}>Kembali</button>
            <button className="button button--primary" type="submit" disabled={creatingMaterial || !forwardLink.trim()}>
              {creatingMaterial ? "Menyimpan materi" : "Simpan materi"}
            </button>
          </div>
        </form>
      )}

      {material && !editingMaterial && (
        <div className="stack-form" style={{ marginBottom: 18 }}>
          <div className="section-heading" style={{ marginBottom: 8 }}>
            <div><h3>Materi</h3><p className="helper-text">{materialSummary(material)}</p></div>
            <button className="button button--ghost" type="button" onClick={openMaterialEditor}>Ubah Materi</button>
          </div>
          <div className="section-heading" style={{ marginBottom: 8 }}>
            <h3>Target Grup LPM</h3>
            {!targetFormOpen && <button className="button button--ghost" type="button" onClick={openAddTarget}>+ Tambah Grup</button>}
          </div>
          {targets.length === 0 && !targetFormOpen && <p className="helper-text">Belum ada target. Tambahkan minimal satu grup buat mulai sebar.</p>}
          {targets.length > 0 && (
            <div className="entitlement-list">
              {targets.map((item) => (
                <article key={item.id} className="entitlement-row">
                  <div><strong>{item.label ?? item.telegramTargetRef}</strong>{item.label && <span>{item.telegramTargetRef}</span>}</div>
                  <div className="entitlement-actions">
                    <button className="button button--ghost" type="button" onClick={() => openEditTarget(item)} disabled={targetBusy === item.id}>Ubah</button>
                    <button className="button button--danger-ghost" type="button" onClick={() => void deleteTarget(item)} disabled={targetBusy === item.id}>
                      {targetBusy === item.id ? "Menghapus" : "Hapus"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {targetFormOpen && (
            <form className="stack-form" onSubmit={submitTarget}>
              <label htmlFor="jaseb-target-ref">{editingTarget ? "Ubah target" : "Target grup (username/link Telegram)"}</label>
              <textarea
                id="jaseb-target-ref"
                rows={editingTarget ? 2 : 4}
                value={targetRef}
                onChange={(event) => setTargetRef(event.target.value)}
                placeholder={editingTarget ? "@nama_grup" : "@grup_satu, @grup_dua\nhttps://t.me/grup_tiga"}
                required
              />
              {!editingTarget && <span className="helper-text">Pisahkan banyak grup dengan koma atau Enter.</span>}
              <div className="account-card__actions">
                <button className="button button--ghost" type="button" onClick={cancelTargetForm} disabled={savingTarget}>Batal</button>
                <button className="button button--primary" type="submit" disabled={savingTarget || !targetRef.trim()}>
                  {savingTarget ? "Menyimpan" : "Simpan target"}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {campaign?.status === "STOPPED" && campaign.errorCode && dismissedStoppedCampaignId !== campaign.id && (
        <div className="notice notice--error" role="alert">
          <span>Jasa Sebar dihentikan otomatis: {deliveryErrorLabel(campaign.errorCode)}</span>
          <button className="text-button" type="button" onClick={() => setDismissedStoppedCampaignId(campaign.id)}>Tutup</button>
        </div>
      )}

      {campaign?.status === "ACTIVE" && campaignOperation && (
        <>
          <p className="helper-text">Status siklus otomatis terakhir:</p>
          <ul className="jaseb-operation-status">
            {campaignOperation.targets.map((item) => (
              <li key={item.id}>
                <span>{item.telegramTargetRef}</span>
                <strong>{DELIVERY_STATUS_LABEL[item.deliveryStatus] ?? item.deliveryStatus}</strong>
                {item.lastErrorCode && <span className="form-error">{deliveryErrorLabel(item.lastErrorCode)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="section-heading">
        <h3 id="jaseb-history-heading">Riwayat sebar</h3>
      </div>
      {history.length === 0 ? (
        <div className="empty-card"><h3>Belum ada riwayat</h3></div>
      ) : (
        <ul className="jaseb-history-list" aria-labelledby="jaseb-history-heading">
          {history.map((entry) => (
            <li key={entry.id}>
              <div>
                {entry.bubbleLink ? (
                  <a href={entry.bubbleLink} target="_blank" rel="noreferrer">{entry.resolvedTitle ?? entry.telegramTargetRef}</a>
                ) : (
                  <span>{entry.resolvedTitle ?? entry.telegramTargetRef}</span>
                )}
              </div>
              <span className="jaseb-history-time">{formatDateTime(entry.sentAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {historyCursor && (
        <button className="text-button" type="button" onClick={() => void loadMoreHistory()} disabled={loadingMoreHistory}>
          {loadingMoreHistory ? "Memuat" : "Muat lebih banyak"}
        </button>
      )}
    </section>
  );
}
