import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  attachAutoCommentChannel,
  createAutoCommentChannelTarget,
  createAutoCommentDivision,
  createAutoCommentKeyword,
  createAutoCommentTemplate,
  deleteAutoCommentChannelTarget,
  deleteAutoCommentDivision,
  deleteAutoCommentKeyword,
  deleteAutoCommentTemplate,
  detachAutoCommentChannel,
  getAutoCommentSettings,
  updateAutoCommentChannelTarget,
  updateAutoCommentDivision,
  updateAutoCommentTemplate,
} from "./api";
import type { AutoCommentDivision, AutoCommentMode, AutoCommentSettings, AutoCommentTemplate } from "./types";

const MODE_LABEL: Record<AutoCommentMode, string> = {
  APPROVAL_REQUIRED: "Perlu Review (Tepat/OOT)",
  AUTO_SEND: "Otomatis Kirim",
};

const RESOLUTION_STATUS_LABEL: Record<string, string> = {
  QUEUED: "Menunggu diproses",
  CHECKING: "Sedang diperiksa",
  JOINING: "Sedang bergabung",
  WAITING_APPROVAL: "Menunggu persetujuan admin grup",
  READY: "Siap",
  NEEDS_REVALIDATION: "Perlu diperiksa ulang",
  FAILED_FINAL: "Gagal",
};

const AUTO_COMMENT_ERROR_LABEL: Record<string, string> = {
  NETWORK_UNAVAILABLE: "Koneksi ke server sedang bermasalah. Coba lagi.",
  REQUEST_FAILED: "Permintaan belum berhasil. Coba lagi.",
  SUBSCRIPTION_REQUIRED: "Paket Auto Komen belum aktif di akun ini.",
  SUBSCRIPTION_EXPIRED: "Paket Auto Komen kamu sudah berakhir.",
  CHANNEL_TARGET_LIMIT_REACHED: "Batas jumlah channel target di paket kamu sudah tercapai.",
  DUPLICATE_SETTING: "Sudah ada data yang sama sebelumnya.",
  SETTING_IN_USE: "Data ini masih dipakai, hapus dulu yang terkait.",
  ACCOUNT_NOT_AVAILABLE: "Akun Telegram tidak tersedia untuk operasi ini.",
  INVALID_AUTO_COMMENT_SETTING: "Data belum valid. Periksa lagi isiannya.",
  DIVISION_NOT_FOUND: "Divisi tidak ditemukan, coba muat ulang.",
  KEYWORD_NOT_FOUND: "Keyword tidak ditemukan, coba muat ulang.",
  TEMPLATE_NOT_FOUND: "Template tidak ditemukan, coba muat ulang.",
  CHANNEL_TARGET_NOT_FOUND: "Channel target tidak ditemukan, coba muat ulang.",
  DIVISION_OR_CHANNEL_TARGET_NOT_FOUND: "Divisi atau channel target tidak ditemukan, coba muat ulang.",
};

function autoCommentErrorLabel(error: unknown): string {
  if (error instanceof ApiError) return AUTO_COMMENT_ERROR_LABEL[error.code] ?? "Permintaan belum berhasil. Coba lagi.";
  return "Permintaan belum berhasil. Coba lagi.";
}

export function AutoCommentPanel({ token }: { token: string }) {
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AutoCommentSettings | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [channelFormOpen, setChannelFormOpen] = useState(false);
  const [channelRef, setChannelRef] = useState("");
  const [creatingChannel, setCreatingChannel] = useState(false);

  const [divisionFormOpen, setDivisionFormOpen] = useState(false);
  const [divisionName, setDivisionName] = useState("");
  const [divisionMode, setDivisionMode] = useState<AutoCommentMode>("APPROVAL_REQUIRED");
  const [creatingDivision, setCreatingDivision] = useState(false);

  const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
  const [newTemplateOpen, setNewTemplateOpen] = useState<Record<string, boolean>>({});
  const [newTemplateText, setNewTemplateText] = useState<Record<string, string>>({});
  const [editingTemplate, setEditingTemplate] = useState<Readonly<{ divisionId: string; id: string; text: string }> | null>(null);

  const withBusy = useCallback(async (id: string, action: () => Promise<void>) => {
    setBusy((current) => new Set(current).add(id));
    setPageError(null);
    try { await action(); }
    catch (cause) { setPageError(autoCommentErrorLabel(cause)); }
    finally { setBusy((current) => { const next = new Set(current); next.delete(id); return next; }); }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setPageError(null);
    try {
      const loaded = await getAutoCommentSettings(token);
      setSettings(loaded);
      setAccountId((current) => (loaded.accounts.some((account) => account.id === current) ? current : loaded.accounts[0]?.id ?? ""));
    } catch (cause) { setPageError(autoCommentErrorLabel(cause)); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const submitChannel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accountId) return;
    setCreatingChannel(true); setPageError(null);
    try {
      await createAutoCommentChannelTarget(token, { accountId, sourceChannelRef: channelRef.trim(), active: true });
      setChannelRef(""); setChannelFormOpen(false);
      await load();
    } catch (cause) { setPageError(autoCommentErrorLabel(cause)); }
    finally { setCreatingChannel(false); }
  };

  const toggleChannelActive = (channelTargetId: string, sourceChannelRef: string, active: boolean) =>
    withBusy(channelTargetId, async () => {
      await updateAutoCommentChannelTarget(token, channelTargetId, { sourceChannelRef, active: !active });
      await load();
    });

  const removeChannel = (channelTargetId: string) =>
    withBusy(channelTargetId, async () => {
      await deleteAutoCommentChannelTarget(token, channelTargetId);
      await load();
    });

  const submitDivision = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accountId) return;
    setCreatingDivision(true); setPageError(null);
    try {
      await createAutoCommentDivision(token, { accountId, name: divisionName.trim(), mode: divisionMode, active: true });
      setDivisionName(""); setDivisionMode("APPROVAL_REQUIRED"); setDivisionFormOpen(false);
      await load();
    } catch (cause) { setPageError(autoCommentErrorLabel(cause)); }
    finally { setCreatingDivision(false); }
  };

  const changeDivisionMode = (division: AutoCommentDivision, mode: AutoCommentMode) =>
    withBusy(division.id, async () => {
      await updateAutoCommentDivision(token, division.id, { name: division.name, mode, active: division.active });
      await load();
    });

  const toggleDivisionActive = (division: AutoCommentDivision) =>
    withBusy(division.id, async () => {
      await updateAutoCommentDivision(token, division.id, { name: division.name, mode: division.mode, active: !division.active });
      await load();
    });

  const removeDivision = (divisionId: string) =>
    withBusy(divisionId, async () => {
      await deleteAutoCommentDivision(token, divisionId);
      await load();
    });

  const submitKeyword = (divisionId: string) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyword = (newKeyword[divisionId] ?? "").trim();
    if (!keyword) return;
    void withBusy(`keyword-add-${divisionId}`, async () => {
      await createAutoCommentKeyword(token, divisionId, keyword);
      setNewKeyword((current) => ({ ...current, [divisionId]: "" }));
      await load();
    });
  };

  const removeKeyword = (divisionId: string, id: string) =>
    withBusy(id, async () => {
      await deleteAutoCommentKeyword(token, divisionId, id);
      await load();
    });

  const submitTemplate = (divisionId: string, templateCount: number) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = (newTemplateText[divisionId] ?? "").trim();
    if (!text) return;
    void withBusy(`template-add-${divisionId}`, async () => {
      await createAutoCommentTemplate(token, divisionId, { text, displayOrder: templateCount, active: true });
      setNewTemplateText((current) => ({ ...current, [divisionId]: "" }));
      setNewTemplateOpen((current) => ({ ...current, [divisionId]: false }));
      await load();
    });
  };

  const toggleTemplateActive = (divisionId: string, template: AutoCommentTemplate) =>
    withBusy(template.id, async () => {
      await updateAutoCommentTemplate(token, divisionId, template.id, { text: template.text, displayOrder: template.displayOrder, active: !template.active });
      await load();
    });

  const saveTemplateEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingTemplate) return;
    const { divisionId, id, text } = editingTemplate;
    const division = settings?.divisions.find((item) => item.id === divisionId);
    const template = division?.templates.find((item) => item.id === id);
    if (!template || !text.trim()) return;
    await withBusy(id, async () => {
      await updateAutoCommentTemplate(token, divisionId, id, { text: text.trim(), displayOrder: template.displayOrder, active: template.active });
      setEditingTemplate(null);
      await load();
    });
  };

  const removeTemplate = (divisionId: string, id: string) =>
    withBusy(id, async () => {
      await deleteAutoCommentTemplate(token, divisionId, id);
      await load();
    });

  const toggleChannelForDivision = (division: AutoCommentDivision, channelTargetId: string, attached: boolean) =>
    withBusy(`${division.id}-${channelTargetId}`, async () => {
      if (attached) await detachAutoCommentChannel(token, division.id, channelTargetId);
      else await attachAutoCommentChannel(token, division.id, channelTargetId);
      await load();
    });

  if (loading) {
    return (
      <section className="content-section" aria-labelledby="auto-comment-heading">
        <div className="section-heading"><h2 id="auto-comment-heading">Auto Komen Menfess</h2></div>
        <div className="account-grid" aria-busy="true"><div className="account-skeleton" /></div>
      </section>
    );
  }

  if (!settings || settings.accounts.length === 0) {
    return (
      <section className="content-section" aria-labelledby="auto-comment-heading">
        <div className="section-heading"><h2 id="auto-comment-heading">Auto Komen Menfess</h2></div>
        <div className="empty-card"><h3>Belum ada akun Userbot terhubung</h3></div>
      </section>
    );
  }

  return (
    <section className="content-section" aria-labelledby="auto-comment-heading">
      <div className="section-heading"><h2 id="auto-comment-heading">Auto Komen Menfess</h2></div>
      {pageError && <div className="notice notice--error" role="alert"><span>{pageError}</span><button className="text-button" type="button" onClick={() => setPageError(null)}>Tutup</button></div>}

      {settings.accounts.length > 1 && (
        <div className="stack-form" style={{ marginBottom: 18 }}>
          <label htmlFor="auto-comment-account">Akun Userbot</label>
          <select id="auto-comment-account" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {settings.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </select>
        </div>
      )}

      <div className="section-heading">
        <h3 id="auto-comment-channels-heading">Channel Target</h3>
        {!channelFormOpen && <button className="button button--ghost" type="button" onClick={() => setChannelFormOpen(true)}>Tambah Channel</button>}
      </div>

      {channelFormOpen && (
        <form className="stack-form" onSubmit={submitChannel}>
          <label htmlFor="auto-comment-channel-ref">Username/link channel publik</label>
          <input
            id="auto-comment-channel-ref"
            value={channelRef}
            onChange={(event) => setChannelRef(event.target.value)}
            placeholder="@nama_channel atau https://t.me/nama_channel"
            required
          />
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => { setChannelFormOpen(false); setChannelRef(""); }} disabled={creatingChannel}>Batal</button>
            <button className="button button--primary" type="submit" disabled={creatingChannel || !channelRef.trim()}>
              {creatingChannel ? "Menyimpan" : "Simpan Channel"}
            </button>
          </div>
        </form>
      )}

      {settings.channelTargets.length === 0 ? (
        <div className="empty-card"><h3>Belum ada channel target</h3></div>
      ) : (
        <ul className="auto-comment-list" aria-labelledby="auto-comment-channels-heading">
          {settings.channelTargets.map((channel) => (
            <li key={channel.id} className="auto-comment-card">
              <div className="auto-comment-card__head">
                <div>
                  <strong>{channel.sourceChannelRef}</strong>
                  <span className={`admin-badge admin-badge--${channel.resolutionStatus.toLowerCase()}`}>
                    {RESOLUTION_STATUS_LABEL[channel.resolutionStatus] ?? channel.resolutionStatus}
                  </span>
                  {!channel.active && <span className="admin-badge admin-badge--disabled">Nonaktif</span>}
                </div>
              </div>
              {channel.lastErrorCode && <p className="form-error">{autoCommentErrorLabel(new ApiError(0, channel.lastErrorCode))}</p>}
              <p className="helper-text">
                Divisi terpasang: {channel.divisionIds.length === 0 ? "belum ada" : channel.divisionIds.map((id) => settings.divisions.find((division) => division.id === id)?.name ?? id).join(", ")}
              </p>
              <div className="account-card__actions">
                <button className="button button--ghost" type="button" disabled={busy.has(channel.id)} onClick={() => void toggleChannelActive(channel.id, channel.sourceChannelRef, channel.active)}>
                  {channel.active ? "Nonaktifkan" : "Aktifkan"}
                </button>
                <button className="button button--danger-ghost" type="button" disabled={busy.has(channel.id)} onClick={() => void removeChannel(channel.id)}>
                  Hapus
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="section-heading">
        <h3 id="auto-comment-divisions-heading">Divisi</h3>
        {!divisionFormOpen && <button className="button button--ghost" type="button" onClick={() => setDivisionFormOpen(true)}>Tambah Divisi</button>}
      </div>

      {divisionFormOpen && (
        <form className="stack-form" onSubmit={submitDivision}>
          <label htmlFor="auto-comment-division-name">Nama Divisi</label>
          <input id="auto-comment-division-name" value={divisionName} onChange={(event) => setDivisionName(event.target.value)} placeholder="Contoh: Jual Beli" required />
          <label htmlFor="auto-comment-division-mode">Mode</label>
          <select id="auto-comment-division-mode" value={divisionMode} onChange={(event) => setDivisionMode(event.target.value as AutoCommentMode)}>
            <option value="APPROVAL_REQUIRED">Perlu Review (Tepat/OOT)</option>
            <option value="AUTO_SEND">Otomatis Kirim</option>
          </select>
          <div className="account-card__actions">
            <button className="button button--ghost" type="button" onClick={() => { setDivisionFormOpen(false); setDivisionName(""); }} disabled={creatingDivision}>Batal</button>
            <button className="button button--primary" type="submit" disabled={creatingDivision || !divisionName.trim()}>
              {creatingDivision ? "Menyimpan" : "Simpan Divisi"}
            </button>
          </div>
        </form>
      )}

      {settings.divisions.length === 0 ? (
        <div className="empty-card"><h3>Belum ada Divisi</h3></div>
      ) : (
        <ul className="auto-comment-list" aria-labelledby="auto-comment-divisions-heading">
          {settings.divisions.map((division) => (
            <li key={division.id} className="auto-comment-card">
              <div className="auto-comment-card__head">
                <div>
                  <strong>{division.name}</strong>
                  {!division.active && <span className="admin-badge admin-badge--disabled">Nonaktif</span>}
                </div>
                <select value={division.mode} disabled={busy.has(division.id)} onChange={(event) => void changeDivisionMode(division, event.target.value as AutoCommentMode)}>
                  <option value="APPROVAL_REQUIRED">{MODE_LABEL.APPROVAL_REQUIRED}</option>
                  <option value="AUTO_SEND">{MODE_LABEL.AUTO_SEND}</option>
                </select>
              </div>

              <p className="helper-text">Keyword</p>
              <div className="chip-list">
                {division.keywords.map((keyword) => (
                  <span key={keyword.id} className="chip">
                    {keyword.keyword}
                    <button type="button" aria-label={`Hapus keyword ${keyword.keyword}`} disabled={busy.has(keyword.id)} onClick={() => void removeKeyword(division.id, keyword.id)}>×</button>
                  </span>
                ))}
                {division.keywords.length === 0 && <span className="helper-text">Belum ada keyword</span>}
              </div>
              <form className="chip-form" onSubmit={submitKeyword(division.id)}>
                <input
                  value={newKeyword[division.id] ?? ""}
                  onChange={(event) => setNewKeyword((current) => ({ ...current, [division.id]: event.target.value }))}
                  placeholder="Tambah keyword..."
                  aria-label="Tambah keyword"
                />
                <button className="button button--ghost" type="submit" disabled={busy.has(`keyword-add-${division.id}`) || !(newKeyword[division.id] ?? "").trim()}>+</button>
              </form>

              <p className="helper-text">Template balasan</p>
              {division.templates.length === 0 && <p className="helper-text">Belum ada template</p>}
              <ul className="auto-comment-template-list">
                {division.templates.map((template) => (
                  <li key={template.id}>
                    {editingTemplate?.id === template.id ? (
                      <form className="stack-form" onSubmit={saveTemplateEdit}>
                        <textarea
                          rows={3}
                          maxLength={4096}
                          value={editingTemplate.text}
                          onChange={(event) => setEditingTemplate({ divisionId: division.id, id: template.id, text: event.target.value })}
                          required
                        />
                        <div className="account-card__actions">
                          <button className="button button--ghost" type="button" onClick={() => setEditingTemplate(null)} disabled={busy.has(template.id)}>Batal</button>
                          <button className="button button--primary" type="submit" disabled={busy.has(template.id) || !editingTemplate.text.trim()}>Simpan</button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <p>{template.text}</p>
                        <div className="account-card__actions">
                          {!template.active && <span className="admin-badge admin-badge--disabled">Nonaktif</span>}
                          <button className="button button--ghost" type="button" disabled={busy.has(template.id)} onClick={() => setEditingTemplate({ divisionId: division.id, id: template.id, text: template.text })}>
                            Ubah
                          </button>
                          <button className="button button--ghost" type="button" disabled={busy.has(template.id)} onClick={() => void toggleTemplateActive(division.id, template)}>
                            {template.active ? "Nonaktifkan" : "Aktifkan"}
                          </button>
                          <button className="button button--danger-ghost" type="button" disabled={busy.has(template.id)} onClick={() => void removeTemplate(division.id, template.id)}>
                            Hapus
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {newTemplateOpen[division.id] ? (
                <form className="stack-form" onSubmit={submitTemplate(division.id, division.templates.length)}>
                  <textarea
                    rows={3}
                    maxLength={4096}
                    value={newTemplateText[division.id] ?? ""}
                    onChange={(event) => setNewTemplateText((current) => ({ ...current, [division.id]: event.target.value }))}
                    placeholder="Tulis template balasan..."
                    required
                  />
                  <div className="account-card__actions">
                    <button className="button button--ghost" type="button" onClick={() => setNewTemplateOpen((current) => ({ ...current, [division.id]: false }))} disabled={busy.has(`template-add-${division.id}`)}>Batal</button>
                    <button className="button button--primary" type="submit" disabled={busy.has(`template-add-${division.id}`) || !(newTemplateText[division.id] ?? "").trim()}>
                      Simpan Template
                    </button>
                  </div>
                </form>
              ) : (
                <button className="text-button" type="button" onClick={() => setNewTemplateOpen((current) => ({ ...current, [division.id]: true }))}>+ Tambah template</button>
              )}

              <p className="helper-text">Channel terpasang</p>
              <div className="chip-list">
                {settings.channelTargets.length === 0 && <span className="helper-text">Belum ada channel target</span>}
                {settings.channelTargets.map((channel) => {
                  const attached = division.channelTargetIds.includes(channel.id);
                  return (
                    <label key={channel.id} className="check-control">
                      <input
                        type="checkbox"
                        checked={attached}
                        disabled={busy.has(`${division.id}-${channel.id}`)}
                        onChange={() => void toggleChannelForDivision(division, channel.id, attached)}
                      />
                      {channel.sourceChannelRef}
                    </label>
                  );
                })}
              </div>

              <div className="account-card__actions">
                <button className="button button--ghost" type="button" disabled={busy.has(division.id)} onClick={() => void toggleDivisionActive(division)}>
                  {division.active ? "Nonaktifkan Divisi" : "Aktifkan Divisi"}
                </button>
                <button className="button button--danger-ghost" type="button" disabled={busy.has(division.id)} onClick={() => void removeDivision(division.id)}>
                  Hapus Divisi
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
