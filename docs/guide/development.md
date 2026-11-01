[← BotLab README](../../README.md)

# Development

```bash
npm run dev            # server (node --watch + tsx) + Vite UI with /api proxy
npm run build          # tsc → dist/ (server + core), vite → apps/web/dist
npm start              # built server serving the built UI (production paths)
npm run typecheck      # core + server + web
npm test               # vitest (SKIP_NETWORK_TESTS=1 skips live-API tests)
npm run lint           # ESLint (0 errors expected)
npm run cli -- <cmd>   # migrate-key | gen-key | set-password | token create/list/revoke
npm run gen:sdk        # regenerate botlab-sdk.d.ts (packages/core/src/sdk/sdkDts.generated.ts) after editing sdk/types.ts
npm run mcp:stdio      # MCP stdio proxy (BOTLAB_URL, BOTLAB_AGENT_TOKEN); mcp:stdio:dev runs it from source
```

```
packages/core/src/      all domain logic, no transport code (createCore, services, db, risk, orders,
                        runtime, ledger, reconcile, recorder, exchange, security, ops/backup)
apps/server/src/        Hono HTTP API, auth, SSE, /healthz, static UI, CLI, entrypoint; mcp/ (MCP tools,
                        resources, /mcp transport) and mcp-stdio.ts (stdio proxy)
apps/web/               React UI (Vite), fetch + EventSource client in src/lib/api.ts
templates/              built-in bot templates
config/*.example.yaml   config defaults (real files are created on first start)
scripts/service.mjs     Windows service (NSSM) / launchd / systemd helper
docs/SPEC.md, docs/PROGRESS.md
```
