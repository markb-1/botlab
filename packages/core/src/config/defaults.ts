/**
 * Default config file contents, written on first start when a file is missing.
 * Kept identical to config/*.example.yaml (enforced by tests/config/config.test.ts).
 */

export const DEFAULT_LIMITS_YAML = `# BotLab hard limits (spec §3.1). Human-owned: the agent can read but never write this file.
# Copy to limits.yaml (or start the app once and it is created with these defaults).
live_trading:
  enabled: false                     # real-money orders; until true, only paper bots run (live bots refused, live orders rejected)
global:
  max_total_exposure_usd: 300        # open position cost + open buy order notional
  max_total_exposure_pct: 0.60       # of wallet equity; the lower of the two applies
  max_long_horizon_pct: 0.25         # max share of total exposure in markets settling in > 30 days
  daily_loss_limit_usd: 100          # trips global halt
  max_open_orders: 50
per_bot_defaults:
  max_order_usd: 25
  allocation_usd: 100                # max exposure for a bot at stage=full
  daily_loss_limit_usd: 50           # trips bot halt
  max_orders_per_hour: 20
  min_hold_minutes: 30               # cannot sell a position opened < N min ago (exits flagged risk_exit are exempt)
per_market:
  max_exposure_usd: 50               # across all bots
  min_liquidity_usd: 5000            # 24h volume
  min_top_of_book_usd: 200           # size at best price on the side we take
  no_trade_before_end_minutes: 60
  max_slippage: 0.02                 # absolute price units from best price for marketable orders
  max_spread: 0.06                   # don't trade if spread wider
orders:
  default_type: limit                # resting post-only by default
  allow_marketable: true             # crossing orders allowed but subject to slippage + fees
  resting_order_ttl_minutes: 240     # GTD expiry
ramp:
  probation_allocation_usd: 20
  probation_min_fills: 20
  probation_min_days: 7
  probation_max_drawdown_pct: 0.25
  new_template_paper_days: 7
  new_template_probation_allocation_usd: 10
agent:                               # MCP agent (spec §7); enforced by the server, never writable by the agent
  monthly_llm_budget_usd: 50         # start_run is refused once this month's run costs reach it
  max_bots_created_per_day: 10       # agent-created bots in the last 24 h
  max_active_bots: 25                # agent-created bots not retired
  max_run_cost_usd: 1.50             # per run, cost recorded by the runner (it stops a run above it)
  max_tool_calls_per_run: 200        # tool calls refused beyond this within one run (finish_run / kill_switch still work)
  max_tool_calls_per_hour: 300       # per agent token, rolling hour, with or without a run (MCP and /api)
approvals:
  new_template_live: false           # set true to require approval
binance:
  enabled: true
  max_order_usd: 25
  allocation_usd: 100
reconcile:
  max_unexplained_usd: 10            # exchange position not matched by local fills (2 runs in a row) above this ⇒ global halt
server:
  start_halted_after_crash: true     # after an unclean shutdown, start with a global halt (clear it by hand)
  script_fetch_allowlist:            # hosts bot scripts may reach via ctx.fetch (https, GET/POST only)
    - gamma-api.polymarket.com
    - data-api.polymarket.com
    - clob.polymarket.com
    - api.binance.com
`;

export const DEFAULT_MANDATE_YAML = `# BotLab agent mandate (spec §3.2). Human-owned: the agent can read but never write this file.
# Copy to mandate.yaml (or start the app once and it is created with these defaults).
budget_usd: 300                       # must be <= limits.global.max_total_exposure_usd
categories:
  allow: [weather-climate, economics, politics-non-us]
  later: [geopolitics, science-tech]   # forecasts recorded (shadow), no bots
  deny:  [sports, crypto-price, mentions, culture-entertainment, us-elections-headline]
markets:
  resolves_within_days: [0, 30]       # default horizon
  long_horizon_days: [30, 90]         # allowed only within limits.global.max_long_horizon_pct
  min_liquidity_usd: 5000
  max_ambiguity_score: 1              # skip markets rated 2-3
strategies:
  allow: [forecast, consistency, resolution_rule]   # template keys
  allow_custom_templates: true
notes: |
  Free-text guidance for the agent (themes of interest, things to avoid).
`;
