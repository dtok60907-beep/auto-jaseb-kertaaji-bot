import assert from "node:assert/strict";
import test from "node:test";
import {
  BroadcastMaterialValidationError,
  parsePublicTelegramPostLink,
  validateBroadcastMaterial,
} from "../src/domain/broadcast-material.ts";

test("manual wording is normalized and immutable", () => {
  const material = validateBroadcastMaterial({ kind: "TEXT", text: "  Promo kos putri  " });

  assert.deepEqual(material, { kind: "TEXT", text: "Promo kos putri" });
  assert.equal(Object.isFrozen(material), true);
});

test("public channel post becomes a canonical forward material with shown source by default", () => {
  const material = validateBroadcastMaterial({
    kind: "FORWARD",
    sourceLink: "https://t.me/KosPutri_Bali/123?single",
  });

  assert.equal(material.kind, "FORWARD");
  if (material.kind !== "FORWARD") return;
  assert.deepEqual(material.source, {
    channelUsername: "KosPutri_Bali",
    messageId: 123,
    canonicalLink: "https://t.me/KosPutri_Bali/123",
  });
  assert.equal(material.sourceAttribution, "SHOW_SOURCE");
  assert.equal(Object.isFrozen(material.source), true);
});

test("forward source attribution can be hidden without changing the source reference", () => {
  const material = validateBroadcastMaterial({
    kind: "FORWARD",
    sourceLink: "https://t.me/kos_putri/99",
    sourceAttribution: "HIDE_SOURCE",
  });

  assert.equal(material.kind, "FORWARD");
  if (material.kind !== "FORWARD") return;
  assert.equal(material.sourceAttribution, "HIDE_SOURCE");
  assert.equal(material.source.canonicalLink, "https://t.me/kos_putri/99");
});

test("rejects private, malformed, or non-post source links", () => {
  for (const sourceLink of [
    "https://t.me/+privateInvite",
    "https://t.me/joinchat/privateInvite",
    "https://t.me/publicchannel",
    "https://example.com/publicchannel/123",
    "https://t.me/publicchannel/not-a-number",
  ]) {
    assert.equal(parsePublicTelegramPostLink(sourceLink), null);
    assert.throws(
      () => validateBroadcastMaterial({ kind: "FORWARD", sourceLink }),
      (error: unknown) => error instanceof BroadcastMaterialValidationError
        && error.issues.some((issue) => issue.field === "sourceLink" && issue.code === "PUBLIC_POST_LINK_REQUIRED"),
    );
  }
});

test("rejects mixed or invalid broadcast material settings clearly", () => {
  assert.throws(
    () => validateBroadcastMaterial({ kind: "TEXT", text: "   " }),
    (error: unknown) => error instanceof BroadcastMaterialValidationError
      && error.issues[0]?.field === "text"
      && error.issues[0]?.code === "REQUIRED",
  );
  assert.throws(
    () => validateBroadcastMaterial({ kind: "FORWARD", sourceLink: "https://t.me/kos_putri/1", sourceAttribution: "MAYBE" }),
    (error: unknown) => error instanceof BroadcastMaterialValidationError
      && error.issues[0]?.field === "sourceAttribution"
      && error.issues[0]?.code === "UNSUPPORTED",
  );
  assert.throws(() => validateBroadcastMaterial({ kind: "TEXT", text: "ok", sourceLink: "https://t.me/kos_putri/1" }), BroadcastMaterialValidationError);
});
