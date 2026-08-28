import type { Sql } from "postgres";
import type {
  BroadcastLpmTargetView,
  BroadcastMaterialView,
  BroadcastSettingsRepository,
} from "./repository.ts";

type MaterialRow = {
  id: string;
  kind: "TEXT" | "FORWARD";
  text_content: string | null;
  forward_channel_username: string | null;
  forward_message_id: number | null;
  source_attribution: "SHOW_SOURCE" | "HIDE_SOURCE" | null;
  active: boolean;
};

type TargetRow = {
  id: string;
  telegram_target_ref: string;
  label: string | null;
  active: boolean;
};

function toMaterialView(row: MaterialRow): BroadcastMaterialView {
  if (row.kind === "TEXT") {
    if (row.text_content === null) throw new Error("invalid TEXT material row");
    return Object.freeze({ id: row.id, kind: "TEXT", text: row.text_content, active: row.active });
  }
  if (row.forward_channel_username === null || row.forward_message_id === null || row.source_attribution === null) {
    throw new Error("invalid FORWARD material row");
  }
  return Object.freeze({
    id: row.id,
    kind: "FORWARD",
    source: Object.freeze({
      channelUsername: row.forward_channel_username,
      messageId: row.forward_message_id,
      canonicalLink: "https://t.me/" + row.forward_channel_username + "/" + row.forward_message_id,
    }),
    sourceAttribution: row.source_attribution,
    active: row.active,
  });
}

function toTargetView(row: TargetRow): BroadcastLpmTargetView {
  return Object.freeze({
    id: row.id,
    telegramTargetRef: row.telegram_target_ref,
    label: row.label,
    active: row.active,
  });
}

export class PostgresBroadcastSettingsRepository implements BroadcastSettingsRepository {
  readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async listMaterials(userId: string): Promise<readonly BroadcastMaterialView[]> {
    const rows = await this.sql<MaterialRow[]>`
      select id::text, kind, text_content, forward_channel_username, forward_message_id,
             source_attribution, active
        from public.broadcast_materials
       where user_id = ${userId}::uuid
       order by created_at, id
    `;
    return Object.freeze(rows.map(toMaterialView));
  }

  async createMaterial(input: Parameters<BroadcastSettingsRepository["createMaterial"]>[0]): Promise<BroadcastMaterialView> {
    const rows = input.material.kind === "TEXT"
      ? await this.sql<MaterialRow[]>`
          insert into public.broadcast_materials (user_id, kind, text_content, active)
          values (${input.userId}::uuid, 'TEXT', ${input.material.text}, ${input.active})
          returning id::text, kind, text_content, forward_channel_username, forward_message_id,
                    source_attribution, active
        `
      : await this.sql<MaterialRow[]>`
          insert into public.broadcast_materials (
            user_id, kind, forward_channel_username, forward_message_id, source_attribution, active
          )
          values (
            ${input.userId}::uuid, 'FORWARD', ${input.material.source.channelUsername},
            ${input.material.source.messageId}, ${input.material.sourceAttribution}, ${input.active}
          )
          returning id::text, kind, text_content, forward_channel_username, forward_message_id,
                    source_attribution, active
        `;
    if (!rows[0]) throw new Error("broadcast material was not persisted");
    return toMaterialView(rows[0]);
  }

  async updateMaterial(input: Parameters<BroadcastSettingsRepository["updateMaterial"]>[0]): Promise<BroadcastMaterialView | null> {
    const rows = input.material.kind === "TEXT"
      ? await this.sql<MaterialRow[]>`
          update public.broadcast_materials
             set kind = 'TEXT', text_content = ${input.material.text},
                 forward_channel_username = null, forward_message_id = null,
                 source_attribution = null, active = ${input.active}
           where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
          returning id::text, kind, text_content, forward_channel_username, forward_message_id,
                    source_attribution, active
        `
      : await this.sql<MaterialRow[]>`
          update public.broadcast_materials
             set kind = 'FORWARD', text_content = null,
                 forward_channel_username = ${input.material.source.channelUsername},
                 forward_message_id = ${input.material.source.messageId},
                 source_attribution = ${input.material.sourceAttribution},
                 active = ${input.active}
           where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
          returning id::text, kind, text_content, forward_channel_username, forward_message_id,
                    source_attribution, active
        `;
    return rows[0] ? toMaterialView(rows[0]) : null;
  }

  async deleteMaterial(input: Parameters<BroadcastSettingsRepository["deleteMaterial"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from public.broadcast_materials
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
       returning id::text
    `;
    return rows.length === 1;
  }

  async listLpmTargets(userId: string): Promise<readonly BroadcastLpmTargetView[]> {
    const rows = await this.sql<TargetRow[]>`
      select id::text, telegram_target_ref, label, active
        from public.broadcast_lpm_targets
       where user_id = ${userId}::uuid
       order by created_at, id
    `;
    return Object.freeze(rows.map(toTargetView));
  }

  async createLpmTarget(input: Parameters<BroadcastSettingsRepository["createLpmTarget"]>[0]): Promise<BroadcastLpmTargetView> {
    const rows = await this.sql<TargetRow[]>`
      insert into public.broadcast_lpm_targets (user_id, telegram_target_ref, label, active)
      values (${input.userId}::uuid, ${input.target.telegramTargetRef}, ${input.target.label}, ${input.target.active})
      returning id::text, telegram_target_ref, label, active
    `;
    if (!rows[0]) throw new Error("broadcast LPM target was not persisted");
    return toTargetView(rows[0]);
  }

  async updateLpmTarget(input: Parameters<BroadcastSettingsRepository["updateLpmTarget"]>[0]): Promise<BroadcastLpmTargetView | null> {
    const rows = await this.sql<TargetRow[]>`
      update public.broadcast_lpm_targets
         set telegram_target_ref = ${input.target.telegramTargetRef},
             label = ${input.target.label},
             active = ${input.target.active}
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
      returning id::text, telegram_target_ref, label, active
    `;
    return rows[0] ? toTargetView(rows[0]) : null;
  }

  async deleteLpmTarget(input: Parameters<BroadcastSettingsRepository["deleteLpmTarget"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from public.broadcast_lpm_targets
       where id = ${input.id}::uuid and user_id = ${input.userId}::uuid
       returning id::text
    `;
    return rows.length === 1;
  }
}
