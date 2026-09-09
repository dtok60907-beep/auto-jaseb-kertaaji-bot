import { useEffect, useRef, useState } from "react";

import { ApiError, createPakasirOrder, refreshPaymentOrder } from "./api";
import type { BuyerStorefront, ServicePackage } from "./types";

const ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi pembayaran sedang bermasalah. Coba lagi.",
  PAKASIR_UNAVAILABLE: "Pakasir belum bisa dihubungi. Coba beberapa saat lagi.",
  PAYMENT_NOT_COMPLETED: "Pembayaran belum tercatat lunas di Pakasir.",
  PAYMENT_VERIFICATION_FAILED: "Data pembayaran tidak cocok. Tim kami perlu memeriksanya.",
  PAYMENT_ORDER_NOT_FOUND: "Invoice pembayaran tidak ditemukan.",
  PACKAGE_NOT_FOUND: "Paket ini sudah tidak tersedia.",
  PACKAGE_NOT_PURCHASABLE: "Paket ini belum dapat dibeli otomatis.",
  SUBSCRIPTION_ALREADY_ACTIVE: "Langganan kamu sudah aktif. Muat ulang halaman.",
};

function errorLabel(error: unknown): string {
  return error instanceof ApiError ? ERROR_LABEL[error.code] ?? "Pembayaran belum berhasil diproses." : "Pembayaran belum berhasil diproses.";
}

function rupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
}

function packageKind(pkg: ServicePackage): string {
  return pkg.type === "USERBOT" ? "Akun kamu sendiri" : "Akun worker Kertaaji";
}

function packageFeatures(pkg: ServicePackage): readonly string[] {
  return pkg.type === "USERBOT"
    ? ["Jasa Sebar", "Auto Komen MF", `${pkg.maxTargetsPerMinute} Grup LPM`, `${pkg.maxTargetsPerMinute} channel target`]
    : ["Jasa Sebar", "Tanpa login akun pribadi", `${pkg.maxTargetsPerMinute} Grup LPM`, "Dijalankan worker admin"];
}

export function Storefront({ token, storefront, onChanged }: {
  token: string;
  storefront: BuyerStorefront;
  onChanged: () => Promise<void>;
}) {
  const [creating, setCreating] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnChecked = useRef(false);

  const checkPayment = async (orderId = storefront.pendingOrder?.id) => {
    if (!orderId || checking) return;
    setChecking(true); setError(null);
    try {
      const order = await refreshPaymentOrder(token, orderId);
      if (order.status === "PAID") await onChanged();
      else setError("Pembayaran belum tercatat lunas di Pakasir.");
    } catch (cause) { setError(errorLabel(cause)); }
    finally { setChecking(false); }
  };

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const returned = parameters.get("payment_return") === "1";
    const returnedOrderId = parameters.get("payment_order_id");
    if (!returned || !returnedOrderId || returnChecked.current) return;
    returnChecked.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("payment_return");
    url.searchParams.delete("payment_order_id");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    void checkPayment(returnedOrderId);
  }, [storefront.pendingOrder]);

  const buy = async (pkg: ServicePackage) => {
    if (creating || checking) return;
    setCreating(pkg.id); setError(null);
    try {
      const order = await createPakasirOrder(token, pkg.id);
      window.location.assign(order.checkoutUrl);
    } catch (cause) { setError(errorLabel(cause)); setCreating(null); }
  };

  return (
    <main className="storefront-page">
      <header className="storefront-topbar">
        <div className="wordmark"><span className="wordmark-dot" aria-hidden="true" />kertaaji</div>
        <span className="storefront-secure"><span aria-hidden="true">◇</span> Pembayaran aman</span>
      </header>

      <section className="storefront-hero">
        <p className="eyebrow">Mulai promosi</p>
        <h1>Pilih cara kerja yang <em>paling pas.</em></h1>
        <p>Satu paket, langsung aktif setelah pembayaran terverifikasi. Tidak perlu menunggu admin.</p>
      </section>

      {error && <div className="notice notice--error storefront-notice" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={() => setError(null)}>Tutup</button></div>}

      {storefront.pendingOrder && (
        <section className="payment-resume-card">
          <div className="payment-resume-card__mark" aria-hidden="true"><span /></div>
          <div className="payment-resume-card__copy">
            <p className="eyebrow">Invoice berjalan</p>
            <h2>{storefront.pendingOrder.packageName}</h2>
            <p>{storefront.pendingOrder.orderCode} · {rupiah(storefront.pendingOrder.amountIdr)}</p>
          </div>
          <div className="payment-resume-card__actions">
            <button className="button button--primary" type="button" onClick={() => window.location.assign(storefront.pendingOrder!.checkoutUrl)}>Lanjut bayar</button>
            <button className="button button--ghost" type="button" onClick={() => void checkPayment()} disabled={checking}>{checking ? "Memeriksa" : "Sudah bayar? Cek status"}</button>
          </div>
        </section>
      )}

      <section className="package-showcase" aria-label="Daftar paket">
        {storefront.packages.length === 0 ? (
          <div className="storefront-empty"><p className="eyebrow">Belum tersedia</p><h2>Paket sedang disiapkan.</h2><p>Coba buka lagi beberapa saat.</p></div>
        ) : storefront.packages.map((pkg, index) => (
          <article className={`package-offer ${pkg.type === "USERBOT" ? "package-offer--userbot" : "package-offer--worker"}`} key={pkg.id} style={{ animationDelay: `${index * 90}ms` }}>
            <div className="package-offer__header">
              <span className="package-offer__number">0{index + 1}</span>
              <span className="package-offer__kind">{packageKind(pkg)}</span>
            </div>
            <div className="package-offer__title"><h2>{pkg.name}</h2><p>{pkg.durationDays} hari akses</p></div>
            <div className="package-offer__price"><strong>{rupiah(pkg.priceIdr)}</strong><span>/ {pkg.durationDays} hari</span></div>
            <ul>{packageFeatures(pkg).map((feature) => <li key={feature}><span aria-hidden="true">✓</span>{feature}</li>)}</ul>
            <button className="button button--primary button--wide package-offer__buy" type="button" disabled={creating !== null || pkg.priceIdr <= 0} onClick={() => void buy(pkg)}>
              {creating === pkg.id ? "Membuat invoice" : pkg.priceIdr <= 0 ? "Hubungi admin" : "Pilih paket ini"}
            </button>
          </article>
        ))}
      </section>

      <footer className="storefront-footer">
        <span>Pembayaran diproses oleh Pakasir</span><span>Aktivasi otomatis setelah status completed terverifikasi</span>
      </footer>
    </main>
  );
}
