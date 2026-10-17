# x402 tender-alert agent

A minimal TypeScript agent for a daily EU tender alert. It asks the `tender-alerts` API for TED notices published since its last successful run that match your CPV codes, buyer countries and value range, prints a digest (buyer, value, deadline, link) and remembers the run time. Paid per run with [x402](https://x402.org) in USDC on Base.

**Price per run:** **$0.10 per run** (one `tender-alerts` call; up to 1,000 TED notices scanned, deterministic filters, values converted to EUR with ECB reference rates).

## Run it
```bash
npm install
cp .env.example .env   # add WALLET_PRIVATE_KEY, or leave it empty for a dry run
set -a; . ./.env; set +a
CPV=72000000,48000000 COUNTRIES=DK,SE,NO MIN_VALUE_EUR=50000 npm start
# schedule it, e.g. cron on weekdays at 08:00:  0 8 * * 1-5  cd /path/to/agent && npm start
```
Requires Node.js 20+. Dry-run output (no key set):
```
tender-alerts: https://tender-alerts-production.up.railway.app/v1/tenders/alerts ($0.10 per call); since=24h ago (first run)
DRY RUN: the service asks $0.1 USDC on Base to 0x922DAc4235B819F3C6778fB206333440b5A045B8. Set WALLET_PRIVATE_KEY to pay.
```

## How it works
```
discover ─▶ call (no payment) ─▶ 402 Payment Required ─▶ check price, payTo, caps ─▶ pay (x402, USDC on Base) ─▶ parse JSON
                                                                                                 └─▶ 503 unable_to_determine: not charged, retry later
```
1. **Discover**: reads the free public catalog `https://agent-services-mcp-production.up.railway.app/catalog.json` to find the endpoint and price.
2. **Call** the endpoint without payment.
3. **Handle 402**: decodes the `PAYMENT-REQUIRED` header and checks the network (Base), the recipient (`ALLOWED_PAY_TO`) and the price against your caps *before* signing anything.
4. **Pay**: `@x402/fetch` signs a USDC transfer authorization with your key and retries the request. The x402 client itself also enforces the per-payment cap (`spendControls.maxAmountPerPayment`), and a hook enforces the per-run budget.
5. **Parse** the JSON result.
6. **Handle 503 `unable_to_determine`**: an official source was down. x402 only settles successful responses, so nothing is charged; the agent retries once after 30 s and otherwise reports that no decision can be made.

Without `WALLET_PRIVATE_KEY` the agent runs in **dry-run mode**: it stops at step 3 and prints what it would pay. Invalid input is rejected with `400` before payment (not charged).

## Spending cap and key handling
- `MAX_USD_PER_CALL` and `MAX_USD_PER_RUN` (see `.env.example`) cap what one call and one run may cost; anything above is refused before signing.
- `ALLOWED_PAY_TO` (default: Price Møbelsnedkeri ApS, `0x922DAc4235B819F3C6778fB206333440b5A045B8`) restricts who can be paid.
- The wallet key is only read from the `WALLET_PRIVATE_KEY` environment variable. Use a dedicated hot wallet holding a few dollars of USDC on Base, never your main wallet. Never commit `.env`.
- Payments are made on Base mainnet in USDC; the facilitator pays the gas.

## Use the same services from an MCP client
All services are also available through one remote MCP server (streamable HTTP). Tools return the x402 payment requirements unless you pass a `payment_signature`; `list_services` is free.
```json
{
  "mcpServers": {
    "agent-services": {
      "type": "http",
      "url": "https://agent-services-mcp-production.up.railway.app/mcp"
    }
  }
}
```
Relevant tools: `tender_alerts` ($0.10), `search_tenders` ($0.03), `search_tender_awards` ($0.03). Free samples of every response: https://agent-services-mcp-production.up.railway.app/samples

## Licence and provider
MIT (this example code). The APIs are operated by Price Møbelsnedkeri ApS (CVR 34223858), Denmark; terms and privacy notices are linked from each endpoint (`/terms`, `/privacy`). Results are information services, not legal or compliance advice. Questions: pp@pricemøbelsnedkeri.dk. Businesses that cannot pay with a wallet: see https://agent-services-mcp-production.up.railway.app/pricing
