import { describe, expect, it } from "vitest";

import { parseTargetInput } from "./target-input";

describe("parseTargetInput", () => {
  it("memisahkan target lewat koma atau baris baru", () => {
    expect(parseTargetInput("@lpm_satu, https://t.me/lpm_dua\n@lpm_tiga"))
      .toEqual(["@lpm_satu", "https://t.me/lpm_dua", "@lpm_tiga"]);
  });

  it("mengabaikan bagian kosong dan duplikat tanpa membedakan kapital", () => {
    expect(parseTargetInput(" @KertaAji,\n@kertaaji, @lain ")).toEqual(["@KertaAji", "@lain"]);
  });

  it("tidak memecah target hanya karena ada spasi", () => {
    expect(parseTargetInput("@satu @dua")).toEqual(["@satu @dua"]);
  });
});
