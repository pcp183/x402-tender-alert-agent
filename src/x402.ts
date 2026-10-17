// Minimal x402 buyer helper: discover → call → handle 402 → pay (with spending caps) → parse → handle 503.
// The wallet key is read from WALLET_PRIVATE_KEY; without it the agent runs in dry-run mode and never pays.
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export const NETWORK = (process.env.X402_NETWORK ?? "eip155:8453") as `${string}:${string}`; // Base mainnet, USDC (eip155:84532 = Base Sepolia for testing)
export const CATALOG = process.env.CATALOG_URL ?? "https://agent-services-mcp-production.up.railway.app/catalog.json";
// Only pay this recipient (Price Møbelsnedkeri ApS). Change it if you point the agent at other x402 services.
export const ALLOWED_PAY_TO = (process.env.ALLOWED_PAY_TO ?? "0x922DAc4235B819F3C6778fB206333440b5A045B8").toLowerCase();

export interface Budget { maxPerCallUsd: number; maxTotalUsd: number; spentUsd: number }
export const budgetFromEnv = (defPerCall: number, defTotal: number): Budget => ({
  maxPerCallUsd: Number(process.env.MAX_USD_PER_CALL ?? defPerCall), maxTotalUsd: Number(process.env.MAX_USD_PER_RUN ?? defTotal), spentUsd: 0 });

export type CallResult =
  | { kind: "ok"; data: any; paidUsd: number; tx?: string }
  | { kind: "dry_run"; priceUsd: number; payTo: string; requirements: any }
  | { kind: "unable_to_determine"; data: any }          // 503: a source was down; x402 does not settle on errors, so nothing was charged
  | { kind: "input_error"; data: any }                  // 400: rejected before payment, not charged
  | { kind: "refused"; reason: string };                // our own spending cap or allow-list said no

// 1) Discover: find a service's endpoint and price in the public catalog (free).
export async function discover(service: string): Promise<{ endpoint: string; price: string; tool: string }> {
  const r = await fetch(CATALOG); if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
  const c: any = await r.json();
  for (const g of c.groups ?? []) for (const s of g.services ?? []) if (s.service === service) return { endpoint: s.endpoint, price: s.price, tool: s.tool };
  throw new Error(`service ${service} not in catalog`);
}

const decodeRequired = (res: Response) => { const h = res.headers.get("payment-required"); return h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null; };

let paidFetch: ReturnType<typeof wrapFetchWithPayment> | null | undefined;
function getPaidFetch(budget: Budget) {
  if (paidFetch !== undefined) return paidFetch;
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) return (paidFetch = null);
  const account = privateKeyToAccount(key as `0x${string}`);
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(account))
    .setSpendControls({ maxAmountPerPayment: `$${budget.maxPerCallUsd}` }) // per-payment cap enforced by the x402 client
    .registerPolicy((_v, reqs) => reqs.filter(r => r.network === NETWORK && String(r.payTo).toLowerCase() === ALLOWED_PAY_TO))
    .onBeforePaymentCreation(async ({ selectedRequirements: r }) => {      // per-run budget
      const usd = Number((r as any).amount) / 1e6;
      if (budget.spentUsd + usd > budget.maxTotalUsd + 1e-9) return { abort: true as const, reason: `run budget $${budget.maxTotalUsd} would be exceeded` };
    });
  return (paidFetch = wrapFetchWithPayment(fetch, client));
}

export async function callService(endpoint: string, body: Record<string, unknown>, budget: Budget): Promise<CallResult> {
  const init = { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) };
  // 2) Call without payment.
  const first = await fetch(endpoint, init);
  if (first.status === 400) return { kind: "input_error", data: await first.json().catch(() => null) };
  if (first.status !== 402) return parse(first, 0);
  // 3) Handle 402: read the price and recipient before paying anything.
  const req = decodeRequired(first); const a = req?.accepts?.find((x: any) => x.network === NETWORK);
  if (!a) return { kind: "refused", reason: "no Base/USDC payment option offered" };
  const priceUsd = Number(a.amount) / 1e6;
  if (String(a.payTo).toLowerCase() !== ALLOWED_PAY_TO) return { kind: "refused", reason: `unexpected payTo ${a.payTo}` };
  if (priceUsd > budget.maxPerCallUsd) return { kind: "refused", reason: `price $${priceUsd} above per-call cap $${budget.maxPerCallUsd}` };
  if (budget.spentUsd + priceUsd > budget.maxTotalUsd + 1e-9) return { kind: "refused", reason: `run budget $${budget.maxTotalUsd} would be exceeded (spent $${budget.spentUsd.toFixed(4)})` };
  const pf = getPaidFetch(budget);
  if (!pf) return { kind: "dry_run", priceUsd, payTo: a.payTo, requirements: req };
  // 4) Pay: the wrapper signs an x402 payment (EIP-3009 USDC authorization) and retries the request.
  let paid: Response;
  try { paid = await pf(endpoint, init); } catch (e: any) { return { kind: "refused", reason: `payment not created: ${e?.message ?? e}` }; }
  return parse(paid, priceUsd);
}

// 5) Parse, and 6) handle 503 unable_to_determine (the facilitator only settles successful responses).
async function parse(res: Response, priceUsd: number): Promise<CallResult> {
  const data = await res.json().catch(() => null);
  if (res.status === 503 || data?.status === "unable_to_determine") return { kind: "unable_to_determine", data };
  if (res.status === 400) return { kind: "input_error", data };
  if (res.status === 402) return { kind: "refused", reason: `payment rejected: ${decodeRequired(res)?.error ?? "unknown reason"} (e.g. not enough USDC on Base in the wallet)` };
  if (!res.ok) return { kind: "refused", reason: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
  const h = res.headers.get("payment-response");
  let tx: string | undefined; try { tx = h ? (decodePaymentResponseHeader(h) as any)?.transaction : undefined; } catch {}
  return { kind: "ok", data, paidUsd: h ? priceUsd : 0, tx };
}
export const charge = (b: Budget, r: CallResult) => { if (r.kind === "ok") b.spentUsd += r.paidUsd; };

// Retry once after a pause when a source is temporarily unavailable (nothing is charged for the 503).
export async function callWithRetry(endpoint: string, body: Record<string, unknown>, budget: Budget, retries = 1, waitMs = 30_000): Promise<CallResult> {
  let r = await callService(endpoint, body, budget);
  for (let i = 0; i < retries && r.kind === "unable_to_determine"; i++) {
    console.error(`  source unavailable (${r.data?.status_reason ?? r.data?.error ?? "503"}); not charged; retrying in ${waitMs / 1000}s`);
    await new Promise(res => setTimeout(res, waitMs)); r = await callService(endpoint, body, budget);
  }
  charge(budget, r); return r;
}
