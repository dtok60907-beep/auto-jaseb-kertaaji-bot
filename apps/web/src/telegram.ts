export function readTelegramInitData(): string {
  const webAppData = typeof window !== "undefined" ? window.Telegram?.WebApp?.initData : undefined;
  if (webAppData) return webAppData;

  if (typeof window === "undefined") return "";
  for (const source of [window.location.hash, window.location.search]) {
    const query = source.startsWith("#") || source.startsWith("?") ? source.slice(1) : source;
    const value = new URLSearchParams(query).get("tgWebAppData");
    if (value) return value;
  }
  return "";
}
