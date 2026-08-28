# Telegram Engine Spike

Harness ini menyimpan hasil benchmark sebagai JSONL agar raw measurement dapat diaudit dan dihitung ulang.

## Record types

Metadata, tepat satu per kandidat:

```json
{"type":"metadata","candidate":"telethon","runtime":"python","runtimeVersion":"...","adapterVersion":"...","dependencyVersion":"...","commit":"..."}
```

Assertion behavior:

```json
{"type":"assertion","candidate":"telethon","scenario":"reconnect","name":"recovered","passed":true,"hardGate":true}
```

Sample metric:

```json
{"type":"sample","candidate":"telethon","scenario":"connect","sessions":10,"metric":"latency","value":123.4,"unit":"ms"}
```

`event_loss` dan `duplicate_side_effect` otomatis menjadi hard gate jika nilainya lebih dari nol.

## Commands

```bash
npm test
npm run summarize -- ./results/example.jsonl
```

CLI exit code `0` berarti seluruh kandidat eligible, `1` berarti ada kandidat gagal gate, dan `2` berarti input/command invalid.
