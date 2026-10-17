// x402 tender-alert agent: once a day, fetch new EU tenders (TED) matching your CPV codes, countries and value range,
// remember when it last ran, and print a short digest. One paid call ($0.10) per run.
import fs from "node:fs";
import { discover, callWithRetry, budgetFromEnv } from "./x402.js";

const STATE = process.env.STATE_FILE ?? "tender-alert.state.json";
const profile = { cpv: process.env.CPV ?? "72000000", countries: process.env.COUNTRIES ?? "DK,SE,NO,DE", min_value: process.env.MIN_VALUE_EUR ? Number(process.env.MIN_VALUE_EUR) : undefined,
  max_value: process.env.MAX_VALUE_EUR ? Number(process.env.MAX_VALUE_EUR) : undefined };
const last = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")).last_run : undefined;
const startedAt = new Date().toISOString();
const budget = budgetFromEnv(0.15, 0.15);

const svc = await discover("tender-alerts");
console.log(`tender-alerts: ${svc.endpoint} (${svc.price}); since=${last ?? "24h ago (first run)"}`);
const body = Object.fromEntries(Object.entries({ ...profile, since: last }).filter(([, v]) => v !== undefined));
const r = await callWithRetry(svc.endpoint, body, budget);

if (r.kind === "dry_run") console.log(`DRY RUN: the service asks $${r.priceUsd} USDC on Base to ${r.payTo}. Set WALLET_PRIVATE_KEY to pay.`);
else if (r.kind === "input_error") { console.log("Input rejected before payment (not charged):", r.data?.error); process.exitCode = 2; }
else if (r.kind === "refused") { console.log("Not paid:", r.reason); process.exitCode = 2; }
else if (r.kind === "unable_to_determine") { console.log("TED or ECB unavailable; nothing charged and last_run not advanced. Retry later.", r.data?.details ?? ""); process.exitCode = 3; }
else {
  const d = r.data;
  console.log(`\n${d.matched} new notice(s) since ${d.query.publication_date_from}${d.truncated ? " (truncated: narrow filters)" : ""}`);
  for (const n of d.notices) {
    const v = n.value ? `${Math.round(n.value.eur ?? n.value.amount).toLocaleString("en")} ${n.value.eur != null ? "EUR" : n.value.currency}` : "value n/a";
    console.log(`- [${n.buyer_country}] ${n.title}\n    ${n.buyer} | ${v} | deadline ${n.deadline ?? "n/a"} (${n.days_left ?? "?"} days) | ${n.url}`);
  }
  for (const note of d.notes ?? []) console.log("note:", note);
  fs.writeFileSync(STATE, JSON.stringify({ last_run: startedAt })); // only advance after a successful, paid run
  console.log(`paid $${r.paidUsd}${r.tx ? ` (tx ${r.tx})` : ""}; spent this run $${budget.spentUsd.toFixed(4)} of $${budget.maxTotalUsd}`);
}
