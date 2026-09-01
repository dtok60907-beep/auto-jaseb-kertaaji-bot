import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  createBroadcastCampaign,
  createBroadcastLpmTarget,
  createBroadcastOperation,
  createTextBroadcastMaterial,
  getBroadcastHistory,
  getBroadcastOperation,
  getBroadcastSettings,
  listBroadcastCampaigns,
  stopBroadcastCampaign,
} from "./api";
import type { BroadcastCampaign, BroadcastHistoryEntry, BroadcastLpmTarget, BroadcastMaterial, BroadcastOperation } from "./types";

const OPERATION_TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED_FINAL", "CANCELLED", "SIDE_EFFECT_UNCERTAIN"]);
const MAX_TEXT_LENGTH = 4096;
const POLL_INTERVAL_MS = 2_000;
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

const JASEB_ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi ke server sedang bermasalah. Coba lagi.",
  REQUEST_FAILED: "Permintaan belum berhasil. Coba lagi.",
  SUBSCRIPTION_REQUIRED: "Paket Jasa Sebar belum aktif di akun ini.",
  SUBSCRIPTION_EXPIRED: "Paket Jasa Sebar kamu sudah berakhir.",
  BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE: "Materi belum tersedia. Buat materi baru dulu.",
  LPM_TARGET_NOT_FOUND_OR_INACTIVE: "Target belum tersedia. Buat target baru dulu.",
  USERBOT_NOT_CONNECTED: "Akun Telegram belum tersambung. Hubungkan akun dulu.",
  WORKER_UNAVAILABLE: "Belum ada akun worker yang tersedia. Coba lagi nanti.",
  IDEMPOTENCY_KEY_CONFLICT: "Permintaan ini sudah pernah diproses.",
  LPM_GROUP_LIMIT_REACHED: "Batas jumlah target Grup LPM paket kamu sudah tercapai.",
  LPM_TARGET_EXISTS: "Target itu sudah kamu tambahkan sebelumnya.",
  CAMPAIGN_ALREADY_ACTIVE: "Sudah ada Jasa Sebar berulang yang sedang berjalan.",
  INTERVAL_TOO_SHORT: `Jeda pengulangan minimal ${MINIMUM_REPEAT_MINUTES} menit.`,
};

function jasebErrorLabel(error: unknown): string {
  if (error instanceof ApiError) return JASEB_ERROR_LABEL[error.code] ?? "Permintaan belum berhasil. Coba lagi.";
  return "Permintaan belum berhasil. Coba lagi.";
}

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `jaseb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
}

export function JasebPanel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [material, setMaterial] = useState<BroadcastMaterial | null>(null);
  const [target, setTarget] = useState<BroadcastLpmTarget | null>(null);
  const [accountMode, setAccountMode] = useState<"JASEB_WORKER" | "USERBOT" | null>(null);
  const [materialText, setMaterialText] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [creatingMaterial, setCreatingMaterial] = useState(false);
  const [creatingTarget, setCreatingTarget] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [operation, setOperation] = useState<BroadcastOperation | null>(null);
  const pollTimer = useRef<number | null>(null);

  const [campaign, setCampaign] = useState<BroadcastCampaign | null>(null);
  const [repeatFormOpen, setRepeatFormOpen] = useState(false);
  const [repeatMinutes, setRepeatMinutes] = useState(String(MINIMUM_REPEAT_MINUTES));
  const [startingCampaign, setStartingCampaign] = useState(false);
  const [stoppingCampaign, setStoppingCampaign] = useState(false);

  const [history, setHistory] = useState<readonly BroadcastHistoryEntry[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const [settings, campaigns, historyPage] = await Promise.all([
        getBroadcastSettings(token),
        listBroadcastCampaigns(token),
        getBroadcastHistory(token),
      ]);
      setMaterial(settings.materials.find((item) => item.active) ?? null);
      setTarget(settings.lpmTargets.find((item) => item.active) ?? null);
      setAccountMode(settings.accountMode);
      setCampaign(campaigns[0] ?? null);
      setHistory(historyPage.entries);
      setHistoryCursor(historyPage.nextCursor);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) { window.clearTimeout(pollTimer.current); pollTimer.current = null; }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollOperation = useCallback((operationId: string) => {
    stopPolling();
    const tick = async () => {
      try {
        const current = await getBroadcastOperation(token, operationId);
        setOperation(current);
        if (!OPERATION_TERMINAL_STATUSES.has(current.status)) {
          pollTimer.current = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
        } else {
          const historyPage = await getBroadcastHistory(token);
          setHistory(historyPage.entries);
          setHistoryCursor(historyPage.nextCursor);
        }
      } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    };
    void tick();
  }, [stopPolling, token]);

  const submitMaterial = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingMaterial(true); setPageError(null);
    try { setMaterial(await createTextBroadcastMaterial(token, materialText.trim())); }
    catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setCreatingMaterial(false); }
  };

  const submitTarget = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingTarget(true); setPageError(null);
    try { setTarget(await createBroadcastLpmTarget(token, { telegramTargetRef: targetRef.trim(), label: targetLabel.trim() || null })); }
    catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setCreatingTarget(false); }
  };

  const launchOnce = async () => {
    if (!material || !target || !accountMode || launching) return;
    setLaunching(true); setPageError(null);
    try {
      const created = await createBroadcastOperation(token, {
        accountMode,
        materialId: material.id,
        targetIds: [target.id],
        idempotencyKey: newIdempotencyKey(),
      });
      setOperation(created.operation);
      pollOperation(created.operation.id);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setLaunching(false); }
  };

  const startRepeat = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!material || !target || !accountMode || startingCampaign) return;
    const minutes = Number(repeatMinutes);
    setStartingCampaign(true); setPageError(null);
    try {
      const created = await createBroadcastCampaign(token, {
        accountMode,
        materialId: material.id,
        targetIds: [target.id],
        intervalSeconds: minutes * 60,
      });
      setCampaign(created);
      setRepeatFormOpen(false);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setStartingCampaign(false); }
  };

  const stopRepeat = async () => {
    if (!campaign || stoppingCampaign) return;
    setStoppingCampaign(true); setPageError(null);
    try {
      await stopBroadcastCampaign(token, campaign.id);
      setCampaign(null);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setStoppingCampaign(false); }
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

      {accountMode !== null && !material && (
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
          <button className="button button--primary button--wide" type="submit" disabled={creatingMaterial || !materialText.trim()}>
            {creatingMaterial ? "Menyimpan materi" : "Simpan materi"}
          </button>
        </form>
      )}

      {material && !target && (
        <form className="stack-form" onSubmit={submitTarget}>
          <label htmlFor="jaseb-target-ref">Target Grup LPM (username/link Telegram)</label>
          <input
            id="jaseb-target-ref"
            value={targetRef}
            onChange={(event) => setTargetRef(event.target.value)}
            placeholder="@nama_grup atau https://t.me/nama_grup"
            required
          />
          <label htmlFor="jaseb-target-label">Label (opsional)</label>
          <input id="jaseb-target-label" value={targetLabel} onChange={(event) => setTargetLabel(event.target.value)} placeholder="Contoh: Grup utama" />
          <button className="button button--primary button--wide" type="submit" disabled={creatingTarget || !targetRef.trim()}>
            {creatingTarget ? "Menyimpan target" : "Simpan target"}
          </button>
        </form>
      )}

      {material && target && campaign && (
        <div className="empty-card">
          <div>
            <h3>Berjalan otomatis</h3>
            <p>
              Mengirim ke {target.label ?? target.telegramTargetRef} tiap {Math.round(campaign.intervalSeconds / 60)} menit.
              {campaign.lastCycleAt ? ` Terakhir: ${formatDateTime(campaign.lastCycleAt)}.` : ""}
            </p>
          </div>
          <button className="button button--danger-ghost" type="button" onClick={() => void stopRepeat()} disabled={stoppingCampaign}>
            {stoppingCampaign ? "Menghentikan" : "Hentikan"}
          </button>
        </div>
      )}

      {material && target && !campaign && !repeatFormOpen && (
        <div className="empty-card">
          <div>
            <h3>Siap disebar</h3>
            <p>Materi dan target sudah tersimpan. Kirim ke {target.label ?? target.telegramTargetRef}.</p>
          </div>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => setRepeatFormOpen(true)} disabled={launching}>
              Sebar Otomatis
            </button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => void launchOnce()}
              disabled={launching || (operation !== null && !OPERATION_TERMINAL_STATUSES.has(operation.status))}
            >
              {launching ? "Memulai" : "Sebar Sekali"}
            </button>
          </div>
        </div>
      )}

      {material && target && !campaign && repeatFormOpen && (
        <form className="stack-form" onSubmit={startRepeat}>
          <label htmlFor="jaseb-repeat-minutes">Ulangi tiap berapa menit</label>
          <input
            id="jaseb-repeat-minutes"
            type="number"
            inputMode="numeric"
            min={MINIMUM_REPEAT_MINUTES}
            value={repeatMinutes}
            onChange={(event) => setRepeatMinutes(event.target.value)}
            required
          />
          <p className="helper-text">Minimal {MINIMUM_REPEAT_MINUTES} menit. Bisa dihentikan kapan saja.</p>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => setRepeatFormOpen(false)} disabled={startingCampaign}>Batal</button>
            <button className="button button--primary" type="submit" disabled={startingCampaign || Number(repeatMinutes) < MINIMUM_REPEAT_MINUTES}>
              {startingCampaign ? "Memulai" : "Mulai"}
            </button>
          </div>
        </form>
      )}

      {operation && (
        <ul className="jaseb-operation-status">
          {operation.targets.map((item) => (
            <li key={item.id}>
              <span>{item.telegramTargetRef}</span>
              <strong>{DELIVERY_STATUS_LABEL[item.deliveryStatus] ?? item.deliveryStatus}</strong>
              {item.lastErrorCode && <span className="form-error">{item.lastErrorCode}</span>}
            </li>
          ))}
        </ul>
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
