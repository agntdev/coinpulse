# CryptoWatch — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A private Telegram bot that lets users maintain personal crypto watchlists and receive alerts when coins hit price thresholds or move by a percentage. Users manage watchlists via buttons or typed tickers, set per-rule thresholds, request on-demand prices, and optionally receive daily summaries. The bot supports quiet hours and provides an owner dashboard with usage analytics and top-fired alerts.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Individual crypto watchers
- Bot owner/operator

## Success criteria

- Users can create and manage watchlists with alerts
- Alerts are delivered accurately with cooldown and quiet hours
- Owner can view analytics and top alerts via /stats command

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Onboarding: ask for display currency and time zone, offer quick-add buttons for BTC, ETH, TON
- **/price** (command, actor: user, command: /price) — Check current price for a specific coin or entire watchlist
- **/watchlist** (command, actor: user, command: /watchlist) — View current watchlist with rules and inline edit/remove buttons
- **/quiet** (command, actor: user, command: /quiet) — Set quiet hours start/end times or disable quiet hours
- **/summary** (command, actor: user, command: /summary) — Set morning summary time or disable morning summary
- **/help** (command, actor: user, command: /help) — Show available commands and examples for threshold and percent rules
- **/stats** (command, actor: owner, command: /stats) — Owner-only: view total users, top-fired tickers, and recent alert examples
- **Quick-add BTC** (button, actor: user, callback: add_coin:BTC) — Add Bitcoin to watchlist with price and alert options
  - inputs: BTC ticker
  - outputs: Watchlist entry for BTC
- **Quick-add ETH** (button, actor: user, callback: add_coin:ETH) — Add Ethereum to watchlist with price and alert options
  - inputs: ETH ticker
  - outputs: Watchlist entry for ETH
- **Quick-add TON** (button, actor: user, callback: add_coin:TON) — Add Toncoin to watchlist with price and alert options
  - inputs: TON ticker
  - outputs: Watchlist entry for TON

## Flows

### Onboarding
_Trigger:_ /start

1. Ask for display currency (default USD)
2. Ask for time zone (if not available)
3. Offer quick-add buttons for BTC, ETH, TON
4. Prompt to type any ticker for custom addition

_Data touched:_ User profile

### Add Threshold Alert
_Trigger:_ Add threshold alert button

1. User selects direction (above/below)
2. User enters price
3. Bot validates numeric input
4. Confirmation message with rule summary and edit/disable/remove options

_Data touched:_ Watchlist entry

### Add Percentage Alert
_Trigger:_ Add % alert button

1. User selects direction (up/down/both)
2. User enters percent (e.g., 5)
3. Confirmation message with rule summary and controls

_Data touched:_ Watchlist entry

### Price Check
_Trigger:_ /price [TICKER|all]

1. If ticker provided: return current price, 1h percent change, and matching rules status
2. If no ticker: return current prices for entire watchlist

_Data touched:_ Watchlist entry, User profile

### Alert Trigger
_Trigger:_ Price threshold or percentage move detected

1. Check if user is outside quiet hours
2. Check if cooldown period has expired
3. If conditions met: send alert with price change details and rule summary
4. Update lastAlertAt timestamp for cooldown

_Data touched:_ Watchlist entry, Alert event

### Owner Analytics
_Trigger:_ /stats

1. Return total users
2. Return top 20 most-fired alerts/tickers
3. Return recent alert examples

_Data touched:_ Owner telemetry

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **User profile** _(retention: persistent)_ — Telegram user id, display name, time zone, settings (quiet hours, morning summary, cooldown period), watchlist, notification preferences
  - fields: Telegram user id, Display name, Time zone, Quiet hours start/end, Morning summary time, Cooldown period, Watchlist, Notification preferences
- **Watchlist entry** _(retention: persistent)_ — Ticker, friendly name, alert rules (thresholds and percentages), enabled flag, last alert timestamp, last alert price
  - fields: Ticker, Friendly name, Threshold rules, Percentage rules, Enabled flag, Last alert timestamp, Last alert price
- **Alert event** _(retention: persistent)_ — User id, ticker, rule id, old price, new price, percent change, timestamp, delivered flag
  - fields: User id, Ticker, Rule id, Old price, New price, Percent change, Timestamp, Delivered flag
- **Owner telemetry** _(retention: persistent)_ — Total users, per-ticker alert counts, per-rule counts, recent alert log
  - fields: Total users, Per-ticker alert counts, Per-rule counts, Recent alert log

## Integrations

- **Telegram** (required) — Bot API messaging
- **Price feed** (required) — Reliable external market-price data with retries and quiet failure handling
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- /stats command to view analytics
- Ability to monitor system health through alert logs

## Notifications

- Price threshold alerts
- Percentage move alerts
- Morning summary of watchlist prices
- Owner alert logs and analytics

## Permissions & privacy

- All user data is private and not shared between users
- Price data is fetched from external source with proper licensing
- User settings and watchlists are stored securely

## Edge cases

- Unknown tickers/typos with fuzzy matching and helpful suggestions
- Price feed failures with retries and no alert delivery
- Quiet hours suppression with no user notification until end of quiet hours
- Cooldown period enforcement to prevent repeated alerts

## Required tests

- End-to-end alert triggering with cooldown and quiet hours
- Watchlist management via buttons and typed tickers
- Owner analytics display via /stats command
- Error handling for price fetch failures and unknown tickers

## Assumptions

- Default cooldown is 30 minutes
- Percentage lookback window is 1 hour
- Morning summary contains only current prices
- Quiet hours are per-user customizable
- Default currency is USD
- Time zone is set during onboarding or defaults to Telegram-local
- Price feed failures are retried and do not produce alerts
- Owner analytics retention is 90 days
