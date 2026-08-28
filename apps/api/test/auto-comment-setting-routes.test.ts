import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type {
  AutoCommentChannelTargetView,
  AutoCommentDivisionView,
  AutoCommentSettingsRepository,
  AutoCommentSettingsView,
  SafeUserbotAccountView,
} from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OWNER_ACCOUNT = "00000000-0000-0000-0000-000000000101";

class EmptyPackages implements PackageRepository {
  async create(): Promise<never> { throw new Error("not used"); }
  async publish(): Promise<null> { return null; }
  async list(): Promise<readonly []> { return []; }
}

class EmptyBroadcasts implements BroadcastSettingsRepository {
  async listMaterials(): Promise<readonly []> { return []; }
  async createMaterial(): Promise<never> { throw new Error("not used"); }
  async updateMaterial(): Promise<null> { return null; }
  async deleteMaterial(): Promise<boolean> { return false; }
  async listLpmTargets(): Promise<readonly []> { return []; }
  async createLpmTarget(): Promise<never> { throw new Error("not used"); }
  async updateLpmTarget(): Promise<null> { return null; }
  async deleteLpmTarget(): Promise<boolean> { return false; }
}

type DivisionRow = {
  id: string; userId: string; accountId: string; name: string; mode: AutoCommentDivisionView["mode"]; active: boolean;
  keywords: { id: string; keyword: string }[];
  templates: { id: string; text: string; displayOrder: number; active: boolean }[];
  channelTargetIds: string[];
};
type ChannelRow = {
  id: string; userId: string; accountId: string; sourceChannelRef: string; discussionTargetRef: string | null;
  resolutionStatus: AutoCommentChannelTargetView["resolutionStatus"]; lastErrorCode: string | null; active: boolean; divisionIds: string[];
};

class FakeAutoComments implements AutoCommentSettingsRepository {
  private divisions: DivisionRow[] = [];
  private channels: ChannelRow[] = [];
  private counter = 1;
  private readonly accounts = new Map<string, readonly SafeUserbotAccountView[]>([
    [OWNER, [{ id: OWNER_ACCOUNT, label: "Akun utama", status: "READY" }]],
    [OTHER, [{ id: "00000000-0000-0000-0000-000000000202", label: "Akun lain", status: "READY" }]],
  ]);

  async listSettings(userId: string): Promise<AutoCommentSettingsView> {
    return {
      accounts: this.accounts.get(userId) ?? [],
      divisions: this.divisions.filter((row) => row.userId === userId).map((row) => this.divisionView(row)),
      channelTargets: this.channels.filter((row) => row.userId === userId).map((row) => this.channelView(row)),
    };
  }

  async createDivision({ userId, division }: Parameters<AutoCommentSettingsRepository["createDivision"]>[0]): Promise<AutoCommentDivisionView> {
    this.assertAccount(userId, division.accountId);
    if (this.divisions.some((row) => row.userId === userId && row.accountId === division.accountId && row.name.toLowerCase() === division.name.toLowerCase())) {
      throw Object.assign(new Error("duplicate"), { code: "23505" });
    }
    const row: DivisionRow = { id: this.id(), userId, accountId: division.accountId, name: division.name, mode: division.mode, active: division.active, keywords: [], templates: [], channelTargetIds: [] };
    this.divisions.push(row);
    return this.divisionView(row);
  }

  async updateDivision({ userId, id, patch }: Parameters<AutoCommentSettingsRepository["updateDivision"]>[0]) {
    const row = this.division(userId, id);
    if (!row) return null;
    if (this.divisions.some((other) => other !== row && other.userId === userId && other.accountId === row.accountId && other.name.toLowerCase() === patch.name.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    row.name = patch.name; row.mode = patch.mode; row.active = patch.active;
    return this.divisionView(row);
  }

  async deleteDivision({ userId, id }: Parameters<AutoCommentSettingsRepository["deleteDivision"]>[0]) {
    const index = this.divisions.findIndex((row) => row.userId === userId && row.id === id);
    if (index < 0) return false;
    this.divisions.splice(index, 1);
    this.channels.forEach((channel) => { channel.divisionIds = channel.divisionIds.filter((divisionId) => divisionId !== id); });
    return true;
  }

  async createKeyword({ userId, divisionId, keyword }: Parameters<AutoCommentSettingsRepository["createKeyword"]>[0]) {
    const row = this.division(userId, divisionId);
    if (!row) return null;
    if (row.keywords.some((entry) => entry.keyword.toLowerCase() === keyword.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const created = { id: this.id(), keyword };
    row.keywords = [...row.keywords, created];
    return created;
  }

  async deleteKeyword({ userId, divisionId, id }: Parameters<AutoCommentSettingsRepository["deleteKeyword"]>[0]) {
    const row = this.division(userId, divisionId);
    if (!row) return false;
    const index = row.keywords.findIndex((keyword) => keyword.id === id);
    if (index < 0) return false;
    row.keywords = row.keywords.filter((keyword) => keyword.id !== id);
    return true;
  }

  async createTemplate({ userId, divisionId, template }: Parameters<AutoCommentSettingsRepository["createTemplate"]>[0]) {
    const row = this.division(userId, divisionId);
    if (!row) return null;
    if (row.templates.some((entry) => entry.text.toLowerCase() === template.text.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const created = { id: this.id(), text: template.text, displayOrder: template.displayOrder, active: template.active };
    row.templates = [...row.templates, created];
    return created;
  }

  async updateTemplate({ userId, divisionId, id, template }: Parameters<AutoCommentSettingsRepository["updateTemplate"]>[0]) {
    const row = this.division(userId, divisionId);
    if (!row) return null;
    if (!row.templates.some((entry) => entry.id === id)) return null;
    if (row.templates.some((entry) => entry.id !== id && entry.text.toLowerCase() === template.text.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const updated = { id, text: template.text, displayOrder: template.displayOrder, active: template.active };
    row.templates = row.templates.map((entry) => entry.id === id ? updated : entry);
    return updated;
  }

  async deleteTemplate({ userId, divisionId, id }: Parameters<AutoCommentSettingsRepository["deleteTemplate"]>[0]) {
    const row = this.division(userId, divisionId);
    if (!row || !row.templates.some((entry) => entry.id === id)) return false;
    row.templates = row.templates.filter((entry) => entry.id !== id);
    return true;
  }

  async createChannelTarget({ userId, target }: Parameters<AutoCommentSettingsRepository["createChannelTarget"]>[0]) {
    this.assertAccount(userId, target.accountId);
    if (this.channels.some((row) => row.userId === userId && row.accountId === target.accountId && row.sourceChannelRef.toLowerCase() === target.sourceChannelRef.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const row: ChannelRow = { id: this.id(), userId, accountId: target.accountId, sourceChannelRef: target.sourceChannelRef, discussionTargetRef: null, resolutionStatus: "QUEUED", lastErrorCode: null, active: target.active, divisionIds: [] };
    this.channels.push(row);
    return this.channelView(row);
  }

  async updateChannelTarget({ userId, id, patch }: Parameters<AutoCommentSettingsRepository["updateChannelTarget"]>[0]) {
    const row = this.channel(userId, id);
    if (!row) return null;
    if (this.channels.some((other) => other !== row && other.userId === userId && other.accountId === row.accountId && other.sourceChannelRef.toLowerCase() === patch.sourceChannelRef.toLowerCase())) throw Object.assign(new Error("duplicate"), { code: "23505" });
    row.sourceChannelRef = patch.sourceChannelRef; row.active = patch.active; row.discussionTargetRef = null; row.resolutionStatus = "QUEUED"; row.lastErrorCode = null;
    return this.channelView(row);
  }

  async deleteChannelTarget({ userId, id }: Parameters<AutoCommentSettingsRepository["deleteChannelTarget"]>[0]) {
    const index = this.channels.findIndex((row) => row.userId === userId && row.id === id);
    if (index < 0) return false;
    const channel = this.channels[index];
    this.divisions.forEach((division) => { division.channelTargetIds = division.channelTargetIds.filter((channelId) => channelId !== channel.id); });
    this.channels.splice(index, 1);
    return true;
  }

  async attachChannel({ userId, divisionId, channelTargetId }: Parameters<AutoCommentSettingsRepository["attachChannel"]>[0]) {
    const division = this.division(userId, divisionId);
    const channel = this.channel(userId, channelTargetId);
    if (!division || !channel || division.accountId !== channel.accountId) return "NOT_FOUND" as const;
    if (!division.channelTargetIds.includes(channelTargetId)) division.channelTargetIds = [...division.channelTargetIds, channelTargetId];
    if (!channel.divisionIds.includes(divisionId)) channel.divisionIds = [...channel.divisionIds, divisionId];
    return "ATTACHED" as const;
  }

  async detachChannel({ userId, divisionId, channelTargetId }: Parameters<AutoCommentSettingsRepository["detachChannel"]>[0]) {
    const division = this.division(userId, divisionId);
    const channel = this.channel(userId, channelTargetId);
    if (!division || !channel || !division.channelTargetIds.includes(channelTargetId)) return false;
    division.channelTargetIds = division.channelTargetIds.filter((id) => id !== channelTargetId);
    channel.divisionIds = channel.divisionIds.filter((id) => id !== divisionId);
    return true;
  }

  private division(userId: string, id: string) { return this.divisions.find((row) => row.userId === userId && row.id === id) ?? null; }
  private channel(userId: string, id: string) { return this.channels.find((row) => row.userId === userId && row.id === id) ?? null; }
  private assertAccount(userId: string, accountId: string) {
    if (!this.accounts.get(userId)?.some((account) => account.id === accountId)) throw Object.assign(new Error("account"), { code: "42501" });
  }
  private id() { return "00000000-0000-0000-0000-" + String(this.counter++).padStart(12, "0"); }
  private divisionView(row: DivisionRow): AutoCommentDivisionView {
    const { userId: _userId, ...view } = row;
    return { ...view, keywords: [...row.keywords], templates: [...row.templates], channelTargetIds: [...row.channelTargetIds] };
  }
  private channelView(row: ChannelRow): AutoCommentChannelTargetView {
    const { userId: _userId, ...view } = row;
    return { ...view, divisionIds: [...row.divisionIds] };
  }
}

function app({ userId = OWNER, adminId = "", autoComments = new FakeAutoComments() }: {
  userId?: string;
  adminId?: string;
  autoComments?: AutoCommentSettingsRepository;
} = {}) {
  return createApi({
    packages: new EmptyPackages(), broadcasts: new EmptyBroadcasts(), autoComments,
    authorizeUser: async () => userId ? { id: userId } : null,
    authorizeAdmin: async () => adminId ? { id: adminId } : null,
  });
}

test("user configures a division, keywords, templates, public channel target, and mapping", async (t) => {
  const server = app();
  t.after(() => server.close());
  const division = await server.inject({ method: "POST", url: "/v1/auto-comment/divisions", payload: { accountId: OWNER_ACCOUNT, name: "Kos Bali" } });
  const divisionId = division.json().division.id;
  const keyword = await server.inject({ method: "POST", url: `/v1/auto-comment/divisions/${divisionId}/keywords`, payload: { keyword: "kos putri" } });
  const template = await server.inject({ method: "POST", url: `/v1/auto-comment/divisions/${divisionId}/templates`, payload: { text: "Masih tersedia ya?", displayOrder: 2 } });
  const channel = await server.inject({ method: "POST", url: "/v1/auto-comment/channel-targets", payload: { accountId: OWNER_ACCOUNT, sourceChannelRef: "https://t.me/InfoKosBali" } });
  const channelId = channel.json().channelTarget.id;
  const mapped = await server.inject({ method: "PUT", url: `/v1/auto-comment/divisions/${divisionId}/channel-targets/${channelId}` });
  const settings = await server.inject({ method: "GET", url: "/v1/auto-comment/settings" });

  assert.equal(division.statusCode, 201);
  assert.deepEqual(division.json().division, { id: divisionId, accountId: OWNER_ACCOUNT, name: "Kos Bali", mode: "APPROVAL_REQUIRED", active: true, keywords: [], templates: [], channelTargetIds: [] });
  assert.equal(keyword.statusCode, 201);
  assert.equal(template.statusCode, 201);
  assert.equal(channel.json().channelTarget.sourceChannelRef, "@InfoKosBali");
  assert.equal(mapped.statusCode, 204);
  assert.deepEqual(settings.json().settings.accounts, [{ id: OWNER_ACCOUNT, label: "Akun utama", status: "READY" }]);
  assert.equal(settings.json().settings.divisions[0].keywords[0].keyword, "kos putri");
  assert.equal(settings.json().settings.divisions[0].templates[0].text, "Masih tersedia ya?");
  assert.deepEqual(settings.json().settings.divisions[0].channelTargetIds, [channelId]);
  assert.deepEqual(settings.json().settings.channelTargets[0].divisionIds, [divisionId]);
});

test("Auto Komen CRUD validates body, normalizes public channel, and returns stable errors", async (t) => {
  const server = app();
  t.after(() => server.close());
  const invalid = await server.inject({ method: "POST", url: "/v1/auto-comment/divisions", payload: { accountId: OWNER_ACCOUNT, name: "x", mode: "BYPASS" } });
  const unavailable = await server.inject({ method: "POST", url: "/v1/auto-comment/divisions", payload: { accountId: "00000000-0000-0000-0000-000000000999", name: "x" } });
  const channel = await server.inject({ method: "POST", url: "/v1/auto-comment/channel-targets", payload: { accountId: OWNER_ACCOUNT, sourceChannelRef: "@bad" } });
  const badTemplate = await server.inject({ method: "POST", url: "/v1/auto-comment/divisions/00000000-0000-0000-0000-000000000001/templates", payload: { text: "x", displayOrder: -1 } });

  assert.deepEqual(invalid.json(), { code: "INVALID_AUTO_COMMENT_SETTING", issues: [{ field: "mode", code: "UNSUPPORTED" }] });
  assert.deepEqual(unavailable.json(), { code: "ACCOUNT_NOT_AVAILABLE" });
  assert.deepEqual(channel.json(), { code: "INVALID_AUTO_COMMENT_SETTING", issues: [{ field: "sourceChannelRef", code: "PUBLIC_CHANNEL_REQUIRED" }] });
  assert.deepEqual(badTemplate.json(), { code: "INVALID_AUTO_COMMENT_SETTING", issues: [{ field: "displayOrder", code: "MUST_BE_NON_NEGATIVE_INTEGER" }] });
});

test("other user cannot read or mutate owner Auto Komen settings", async (t) => {
  const shared = new FakeAutoComments();
  const owner = app({ autoComments: shared });
  const other = app({ userId: OTHER, autoComments: shared });
  t.after(() => owner.close());
  t.after(() => other.close());
  const created = await owner.inject({ method: "POST", url: "/v1/auto-comment/divisions", payload: { accountId: OWNER_ACCOUNT, name: "Privat" } });
  const id = created.json().division.id;
  const read = await other.inject({ method: "GET", url: "/v1/auto-comment/settings" });
  const update = await other.inject({ method: "PUT", url: `/v1/auto-comment/divisions/${id}`, payload: { name: "diambil", mode: "AUTO_SEND", active: true } });

  assert.deepEqual(read.json().settings.divisions, []);
  assert.deepEqual(update.json(), { code: "DIVISION_NOT_FOUND" });
});

test("admin sees and edits the same selected user's Auto Komen setting without account connection access", async (t) => {
  const shared = new FakeAutoComments();
  const owner = app({ autoComments: shared });
  const admin = app({ userId: "", adminId: ADMIN, autoComments: shared });
  t.after(() => owner.close());
  t.after(() => admin.close());
  const created = await owner.inject({ method: "POST", url: "/v1/auto-comment/divisions", payload: { accountId: OWNER_ACCOUNT, name: "Dibantu" } });
  const id = created.json().division.id;
  const viewed = await admin.inject({ method: "GET", url: `/v1/admin/users/${OWNER}/auto-comment/settings` });
  const updated = await admin.inject({ method: "PUT", url: `/v1/admin/users/${OWNER}/auto-comment/divisions/${id}`, payload: { name: "Sudah disetting admin", mode: "AUTO_SEND", active: false } });
  const ownerView = await owner.inject({ method: "GET", url: "/v1/auto-comment/settings" });

  assert.equal(viewed.statusCode, 200);
  assert.equal(viewed.json().settings.divisions[0].name, "Dibantu");
  assert.equal(updated.json().division.mode, "AUTO_SEND");
  assert.equal(ownerView.json().settings.divisions[0].name, "Sudah disetting admin");
  assert.equal(JSON.stringify(viewed.json()).includes("encrypted_session"), false);
});

test("admin Auto Komen routes require explicit admin authority and selected user", async (t) => {
  const noAdmin = app({ userId: "" });
  const admin = app({ userId: "", adminId: ADMIN });
  t.after(() => noAdmin.close());
  t.after(() => admin.close());
  const forbidden = await noAdmin.inject({ method: "GET", url: `/v1/admin/users/${OWNER}/auto-comment/settings` });
  const invalid = await admin.inject({ method: "GET", url: "/v1/admin/users/nope/auto-comment/settings" });

  assert.deepEqual(forbidden.json(), { code: "ADMIN_REQUIRED" });
  assert.deepEqual(invalid.json(), { code: "INVALID_USER_ID" });
});
