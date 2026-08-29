# Telegram contract

Provider-neutral boundary shared by the API planner/preparation code and the
Telegram engine. This package must not import Fastify, PostgreSQL, Teleproto, or
product-domain payloads. Provider implementation stays in `apps/engine`; product
material dispatch stays in `apps/api`.
