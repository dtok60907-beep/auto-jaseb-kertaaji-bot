import { afterEach, describe, expect, it } from "vitest";

import { readTelegramInitData } from "./telegram";

const previousWindow = globalThis.window;

afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  else Reflect.deleteProperty(globalThis, "window");
});

describe("readTelegramInitData", () => {
  it("prefers the verified Telegram WebApp bridge value", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      Telegram: { WebApp: { initData: "bridge-data" } },
      location: { hash: "#tgWebAppData=url-data", search: "" },
    } });
    expect(readTelegramInitData()).toBe("bridge-data");
  });

  it("reads Telegram launch data from the hash when the bridge is empty", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      Telegram: { WebApp: { initData: "" } },
      location: { hash: "#tgWebAppData=query_id%3Dabc%26user%3D%257B%2522id%2522%253A1%257D", search: "" },
    } });
    expect(readTelegramInitData()).toBe('query_id=abc&user=%7B%22id%22%3A1%7D');
  });

  it("also accepts launch data in the query string", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      Telegram: { WebApp: { initData: "" } },
      location: { hash: "", search: "?tgWebAppData=query_id%3Dabc" },
    } });
    expect(readTelegramInitData()).toBe("query_id=abc");
  });
});
