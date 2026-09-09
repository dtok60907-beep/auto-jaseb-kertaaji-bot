# Historical canary runbook (retired)

The admission gate documented by the previous version of this file was retired by
`20260909130000_pakasir_checkout.sql`. A correctly signed Telegram Mini App user can
now open the buyer storefront without being placed in a canary slot. Service access
is still denied until the user owns an active entitlement.

The `canary_admissions` table and operator code remain only as historical deployment
data. They are not wired into the production API or admin interface and must not be
used as an onboarding mechanism.

Admin authority remains independent from buyer onboarding. Grant or revoke admin
access only through the existing trusted operator workflow, using an application
user that has already authenticated successfully.
