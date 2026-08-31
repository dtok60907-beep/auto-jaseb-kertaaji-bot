/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
  __JASEB_RUNTIME_CONFIG__?: { apiBaseUrl?: string };
}
