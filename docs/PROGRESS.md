# BotLab v3 — Development Progress

Implementation log for `docs/SPEC.md`. Each chunk is implemented, reviewed independently, fixed, then committed.

## Plan

| chunk | scope | status |
|---|---|---|
| 1a | `.gitattributes`, 3-OS CI, config system (limits schema/loader), RiskEngine, `orders` + `risk_state` tables | pending |
| 1b | OrderService choke point, GTD limit orders, fee table, route all live orders through RiskEngine | pending |
| 1c | Halts, daily loss, kill switch, start-halted-after-crash, ramp stages, audit log | pending |
| 1d | Sandbox hardening, backtests in worker, AES-GCM migration, copy-trading sell fix | pending |
| 1e | Telegram notifications, config hot reload | pending |
| 2a | Forecast ledger, scoring, category rights, market cache | pending |
| 2b | Order-book recorder, reconciler | pending |
| 3a | Extract `packages/core` + services | pending |
| 3b | HTTP server + SSE + auth, web client on fetch, remove Electron + AI assistant, cross-platform scripts, Docker | pending |
| 3c | UI pages: Risk, Ledger, Audit, config editing | pending |

Testing policy: tests only for safety- and money-critical logic and core domain logic; existing suite must stay green.
Known pre-existing failures: `tests/copytrading/1-polymarket-data-api.test.ts` calls the live Polymarket API (fails without network).

## Log
