import assert from "node:assert/strict";
import test from "node:test";
import {
  DivisionValidationError,
  createAutoCommentCandidate,
  decideAutoCommentCandidate,
  validateDivisionConfig,
} from "../../../packages/auto-comment-contract/src/index.ts";

const division = {
  divisionId: "division-kos",
  accountId: "userbot-1",
  name: "Kos Putri",
  keywords: ["kos putri", "cari kos"],
  templates: ["Halo, masih cari kos putri?"],
};

function candidateInput(mode?: "APPROVAL_REQUIRED" | "AUTO_SEND") {
  return {
    candidateId: "candidate-1",
    division: { ...division, ...(mode ? { mode } : {}) },
    channelId: "channel-mf",
    channelPostId: "post-99",
    discussionTargetId: "discussion-mf",
    matchedKeywords: ["cari kos"],
    template: { templateId: "template-1", text: "Halo, masih cari kos putri?" },
  };
}

test("division defaults to approval required and freezes normalized configuration", () => {
  const config = validateDivisionConfig({ ...division, name: "  Kos Putri  ", keywords: [" Cari Kos "] });

  assert.equal(config.mode, "APPROVAL_REQUIRED");
  assert.equal(config.name, "Kos Putri");
  assert.deepEqual(config.keywords, ["Cari Kos"]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.keywords), true);
});

test("division validation rejects unsupported mode and duplicated keyword", () => {
  assert.throws(
    () => validateDivisionConfig({ ...division, mode: "DIRECT_SEND", keywords: ["kos", "KOS"] }),
    (error: unknown) => {
      if (!(error instanceof DivisionValidationError)) return false;
      assert.deepEqual(error.issues, [
        { field: "mode", code: "UNSUPPORTED" },
        { field: "keywords", code: "DUPLICATE" },
      ]);
      return true;
    },
  );
});

test("approval mode creates a frozen pending review candidate without an outbox command", () => {
  const input = candidateInput();
  const result = createAutoCommentCandidate(input);

  assert.equal(result.status, "PENDING_REVIEW");
  assert.equal(result.command, null);
  assert.equal(result.candidate.status, "PENDING_REVIEW");
  assert.equal(result.candidate.template.text, "Halo, masih cari kos putri?");
  assert.equal(Object.isFrozen(result.candidate.template), true);
  assert.equal(result.candidate.idempotencyKey, "comment:division-kos:userbot-1:channel-mf:post-99");
  input.template.text = "template baru";
  assert.equal(result.candidate.template.text, "Halo, masih cari kos putri?");
});

test("candidate snapshot rejects a template or keyword outside its division", () => {
  assert.throws(() => createAutoCommentCandidate({ ...candidateInput(), template: { templateId: "template-x", text: "template asing" } }), /tidak berasal dari Divisi/);
  assert.throws(() => createAutoCommentCandidate({ ...candidateInput(), matchedKeywords: ["keyword asing"] }), /tidak berasal dari Divisi/);
});

test("Tepat turns exactly one pending candidate into one queued comment command", () => {
  const created = createAutoCommentCandidate(candidateInput());
  if (created.status !== "PENDING_REVIEW") throw new Error("expected pending review");

  const approved = decideAutoCommentCandidate(created.candidate, "TEPAT");
  assert.equal(approved.status, "COMMENT_QUEUED");
  assert.equal(approved.candidate.decision, "TEPAT");
  assert.equal(approved.command?.candidateId, "candidate-1");
  assert.equal(approved.command?.text, "Halo, masih cari kos putri?");

  const repeated = decideAutoCommentCandidate(approved.candidate, "TEPAT");
  assert.equal(repeated.status, "ALREADY_DECIDED");
  assert.equal(repeated.command, null);
});

test("OOT creates no command and auto send queues one command without a review", () => {
  const pending = createAutoCommentCandidate(candidateInput());
  if (pending.status !== "PENDING_REVIEW") throw new Error("expected pending review");
  const skipped = decideAutoCommentCandidate(pending.candidate, "OOT");
  assert.equal(skipped.status, "OOT");
  assert.equal(skipped.candidate.decision, "OOT");
  assert.equal(skipped.command, null);

  const auto = createAutoCommentCandidate(candidateInput("AUTO_SEND"));
  assert.equal(auto.status, "COMMENT_QUEUED");
  assert.equal(auto.candidate.decision, null);
  assert.equal(auto.command?.idempotencyKey, auto.candidate.idempotencyKey);
  assert.equal(decideAutoCommentCandidate(auto.candidate, "TEPAT").status, "NOT_AWAITING_REVIEW");
});
