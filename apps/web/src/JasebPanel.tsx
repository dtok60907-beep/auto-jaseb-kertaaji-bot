import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  createBroadcastLpmTarget,
  createBroadcastOperation,
  createTextBroadcastMaterial,
  getBroadcastOperation,
  getBroadcastSettings,
} from "./api";
import type { BroadcastLpmTarget, BroadcastMaterial, BroadcastOperation } from "./types";

const OPERATION_TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED_FINAL", "CANCELLED", "SIDE_EFFECT_UNCERTAIN"]);
const MAX_TEXT_LENGTH = 4096;
const POLL_INTERVAL_MS = 2_000;

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
};

function jasebErrorLabel(error: unknown): string {
  if (error instanceof ApiError) return JASEB_ERROR_LABEL[error.code] ?? "Permintaan belum berhasil. Coba lagi.";
  return "Permintaan belum berhasil. Coba lagi.";
}

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `jaseb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function JasebPanel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [material, setMaterial] = useState<BroadcastMaterial | null>(null);
  const [target, setTarget] = useState<BroadcastLpmTarget | null>(null);
  const [materialText, setMaterialText] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [targetLabel, setTargetLabel] = useState("");
  const [creatingMaterial, setCreatingMaterial] = useState(false);
  const [creatingTarget, setCreatingTarget] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [operation, setOperation] = useState<BroadcastOperation | null>(null);
  const pollTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const settings = await getBroadcastSettings(token);
      setMaterial(settings.materials.find((item) => item.active) ?? null);
      setTarget(settings.lpmTargets.find((item) => item.active) ?? null);
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

  const launch = async () => {
    if (!material || !target || launching) return;
    setLaunching(true); setPageError(null);
    try {
      const created = await createBroadcastOperation(token, {
        accountMode: "USERBOT",
        materialId: material.id,
        targetIds: [target.id],
        idempotencyKey: newIdempotencyKey(),
      });
      setOperation(created.operation);
      pollOperation(created.operation.id);
    } catch (cause) { setPageError(jasebErrorLabel(cause)); }
    finally { setLaunching(false); }
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

      {!material && (
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

      {material && target && (
        <div className="empty-card">
          <div>
            <h3>Siap disebar</h3>
            <p>Materi dan target sudah tersimpan. Jalankan Jasa Sebar ke {target.label ?? target.telegramTargetRef}.</p>
          </div>
          <button className="button button--primary" type="button" onClick={() => void launch()} disabled={launching || (operation !== null && !OPERATION_TERMINAL_STATUSES.has(operation.status))}>
            {launching ? "Memulai" : "Jalankan"}
          </button>
        </div>
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
    </section>
  );
}
