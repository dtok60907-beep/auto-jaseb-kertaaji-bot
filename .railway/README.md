# Kertaaji Railway infrastructure

This directory is the single source of truth for the dedicated production Railway
project. Secrets are represented by `preserve()` and remain stored only in Railway.

From the repository root:

```bash
railway link --project e4c71c85-9512-4642-9d52-628909def246 --environment production
railway config plan
railway config apply
```

Never use `--show-values`, `--decrypt-variables`, or `--include-variables` in shared
logs. Review every plan for unexpected deletes before applying it.
