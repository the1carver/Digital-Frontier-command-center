import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";

/*
  ============================================================================
  DIGITAL FRONTIER — PORTFOLIO COMMAND CENTER  (Level 2.5: MULTI-WEEK RS)
  ============================================================================
  WHAT CHANGED FROM LEVEL 2 (read this, future-you):
  - RS no longer uses just the 24h move. It now pulls multi-week PRICE HISTORY
    and scores each alt vs BTC over 7 / 14 / 30-day windows, then blends them
    (weighted toward the longer windows) so a one-day pop can't flip a verdict.
  - This is the difference between "SOL is up today" (noise) and "SOL has been
    out-trending BTC for weeks" (a real rotation signal).

  THE KEY ENGINEERING IDEA — MATCH REFRESH RATE TO HOW FAST DATA CHANGES:
  - LIVE PRICES change every second  -> fast loop, every 60s, ONE batched call.
  - MULTI-WEEK TREND barely moves in an hour -> slow loop, every 10 min,
    and it's ONE CALL PER COIN (CoinGecko's history endpoint isn't batchable).
  - So we STAGGER the ~13 history calls with a delay between each to avoid the
    free-tier rate limiter, and we only do it occasionally. Hammering an API
    for data that didn't change is how you get blocked.

  FALLBACK:
  - Any failed call keeps the last good value. Status badges show LIVE/STALE.
  ============================================================================
*/

const PASSCODE = "frontier";
const PRICE_REFRESH_MS = 60_000;       // live prices: every 60s
const HISTORY_REFRESH_MS = 600_000;    // trend history: every 10 min
const STAGGER_MS = 1500;               // delay between per-coin history calls

const INITIAL = [
  { id: "btc",  ticker: "BTC",  name: "Bitcoin",            cgId: "bitcoin",      qty: 0.355,  bucket: "crypto", manualPrice: null },
  { id: "sol",  ticker: "SOL",  name: "Solana",             cgId: "solana",       qty: 21.5,   bucket: "crypto", manualPrice: null },
  { id: "eth",  ticker: "ETH",  name: "Ethereum",           cgId: "ethereum",     qty: 0.62,   bucket: "crypto", manualPrice: null },
  { id: "link", ticker: "LINK", name: "Chainlink",          cgId: "chainlink",    qty: 38,     bucket: "crypto", manualPrice: null },
  { id: "xlm",  ticker: "XLM",  name: "Stellar",            cgId: "stellar",      qty: 1450,   bucket: "crypto", manualPrice: null },
  { id: "uni",  ticker: "UNI",  name: "Uniswap",            cgId: "uniswap",      qty: 34,     bucket: "crypto", manualPrice: null },
  { id: "bgb",  ticker: "BGB",  name: "Bitget Token",       cgId: "bitget-token", qty: 42,     bucket: "crypto", manualPrice: null },
  { id: "sui",  ticker: "SUI",  name: "Sui",                cgId: "sui",          qty: 62,     bucket: "crypto", manualPrice: null },
  { id: "arb",  ticker: "ARB",  name: "Arbitrum",           cgId: "arbitrum",     qty: 175,    bucket: "crypto", manualPrice: null },
  { id: "algo", ticker: "ALGO", name: "Algorand",           cgId: "algorand",     qty: 320,    bucket: "crypto", manualPrice: null },
  { id: "susde",ticker: "sUSDe",name: "Ethena Staked USDe", cgId: "ethena-staked-usde", qty: 489.51, bucket: "stable", manualPrice: null },
  { id: "usdc", ticker: "USDC", name: "USD Coin",           cgId: "usd-coin",     qty: 281.75, bucket: "stable", manualPrice: null },
  { id: "usdt", ticker: "USDT", name: "Tether",             cgId: "tether",       qty: 12.30,  bucket: "stable", manualPrice: null },
  { id: "cash", ticker: "CASH", name: "Coinbase Cash",      cgId: null,           qty: 1,      bucket: "stable", manualPrice: 1235 },
  { id: "umac", ticker: "UMAC", name: "Unusual Machines",   cgId: null,           qty: 1,      bucket: "equity", manualPrice: 305.58 },
  { id: "orcl", ticker: "ORCL", name: "Oracle",             cgId: null,           qty: 1,      bucket: "equity", manualPrice: 226.50 },
  { id: "intc", ticker: "INTC", name: "Intel",              cgId: null,           qty: 1,      bucket: "equity", manualPrice: 80.51 },
  { id: "rgti", ticker: "RGTI", name: "Rigetti Computing",  cgId: null,           qty: 1,      bucket: "equity", manualPrice: 46.48 },
];

const RS_ALTS = ["SOL", "ETH", "LINK", "XLM", "UNI", "BGB", "SUI", "ARB", "ALGO"];

const RS_WINDOWS = [
  { days: 7,  weight: 0.25, key: "d7" },
  { days: 14, weight: 0.35, key: "d14" },
  { days: 30, weight: 0.40, key: "d30" },
];

const C = {
  bg: "#0a0e14", panel: "#11161f", panel2: "#161c27", line: "#243042",
  ink: "#e8eef5", dim: "#7d8aa0", blue: "#2563ff", cyan: "#22d3ee",
  amber: "#f5a524", green: "#34d399", red: "#f87171",
};
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Oxanium:wght@500;700;800&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
const fmtUSD = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 });
const fmtPct = (n) => `${n.toFixed(1)}%`;
const fmtSigned = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// FETCHERS — use serverless proxies when deployed, direct CoinGecko locally
// ---------------------------------------------------------------------------
async function fetchPrices(cgIds) {
  // Use the serverless proxy when deployed; fall back to CoinGecko directly in local dev.
  const proxy = `/api/prices?ids=${cgIds.join(",")}&vs=usd`;
  const direct = `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd&include_24hr_change=true`;
  const proxyRes = await fetch(proxy).catch(() => null);
  if (proxyRes && proxyRes.ok) return proxyRes.json();
  const res = await fetch(direct);
  if (!res.ok) throw new Error(`price ${res.status}`);
  return res.json();
}
async function fetchDominance() {
  const res = await fetch("https://api.coingecko.com/api/v3/global");
  if (!res.ok) throw new Error("global");
  const d = await res.json();
  return d?.data?.market_cap_percentage?.btc ?? null;
}
async function fetchHistory(cgId, days) {
  const url = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history ${cgId} ${res.status}`);
  const d = await res.json();
  return d.prices || [];
}
function pctChange(series) {
  if (!series || series.length < 2) return null;
  const first = series[0][1];
  const last = series[series.length - 1][1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

// ---------------------------------------------------------------------------
// REGIME ENGINE
// ---------------------------------------------------------------------------
function computeRegime({ dominance, btcTrend, macro }) {
  if (btcTrend === "down" || macro === "risk-off")
    return { state: "DE-RISK", color: C.red,
      headline: "Reduce exposure. Raise stables. No new leverage.",
      detail: "BTC's trend is broken or macro is risk-off. Move toward BTC core + stables, trim weak alts. Capital-preservation week." };
  if (dominance === "falling" && macro === "risk-on" && btcTrend !== "down")
    return { state: "ROTATE", color: C.cyan,
      headline: "Let the strongest alts lead. Rotate from BTC into RS winners.",
      detail: "Dominance falling + risk-on = alt-leadership backdrop. Use the blended RS scores below to move measured amounts from BTC into genuine trend-outperformers. Losers still get cut." };
  return { state: "DEFEND", color: C.amber,
    headline: "BTC stays core. Alts must beat it or rotate back.",
    detail: "Dominance steady/rising, trend intact. Bitcoin is the place to be. Alts not beating BTC on blended RS rotate back. Default posture given ~74% net-long BTC." };
}

function blendedRS(altHist, btcHist) {
  if (!altHist || !btcHist) return { score: null, windows: {}, ready: false };
  let blended = 0, totalW = 0;
  const windows = {};
  for (const w of RS_WINDOWS) {
    const a = altHist[w.key];
    const b = btcHist[w.key];
    if (a == null || b == null) continue;
    const ratio = Math.abs(b) < 0.5 ? (a > b ? 1.3 : a < b ? 0.7 : 1) : a / b;
    const outperf = a - b;
    windows[w.key] = { altPct: a, btcPct: b, ratio, outperf };
    blended += outperf * w.weight;
    totalW += w.weight;
  }
  if (totalW === 0) return { score: null, windows, ready: false };
  const score = blended / totalW;
  return { score, windows, ready: true };
}

function rsVerdictFromScore(score) {
  if (score == null) return { label: "—", color: C.dim, action: "Loading trend…" };
  if (score > 3) return { label: "OUTPERFORM", color: C.green, action: "Earning its slot — hold/add" };
  if (score < -3) return { label: "UNDERPERFORM", color: C.red, action: "Rotate back to BTC" };
  return { label: "NEUTRAL", color: C.dim, action: "Hold & watch" };
}

function sizePosition({ account, riskPct, entry, stop }) {
  const riskAmt = account * (riskPct / 100);
  const per = Math.abs(entry - stop);
  if (per <= 0) return null;
  return { riskAmt, units: riskAmt / per, notional: (riskAmt / per) * entry, perUnitRisk: per };
}

// ---------------------------------------------------------------------------
// UI PRIMITIVES
// ---------------------------------------------------------------------------
const Panel = ({ children, style }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20, ...style }}>{children}</div>
);
const Label = ({ children }) => (
  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: C.dim, marginBottom: 10 }}>{children}</div>
);

function Gate({ onUnlock }) {
  const [val, setVal] = useState(""); const [err, setErr] = useState(false);
  const submit = () => (val === PASSCODE ? onUnlock() : setErr(true));
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg, fontFamily: "'Inter', sans-serif" }}>
      <div style={{ textAlign: "center", width: 320 }}>
        <div style={{ fontFamily: "'Oxanium', sans-serif", fontWeight: 800, fontSize: 22, color: C.ink, letterSpacing: 1 }}>DIGITAL FRONTIER</div>
        <div style={{ color: C.cyan, fontSize: 12, letterSpacing: 3, marginBottom: 28, fontFamily: "'IBM Plex Mono', monospace" }}>COMMAND CENTER</div>
        <input type="password" value={val} placeholder="passcode"
          onChange={(e) => { setVal(e.target.value); setErr(false); }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ width: "100%", padding: "12px 14px", background: C.panel, border: `1px solid ${err ? C.red : C.line}`, borderRadius: 10, color: C.ink, fontSize: 15, outline: "none", fontFamily: "'IBM Plex Mono', monospace" }} />
        <button onClick={submit} style={{ width: "100%", marginTop: 12, padding: 12, background: C.blue, border: "none", borderRadius: 10, color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" }}>Enter</button>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>Incorrect passcode</div>}
      </div>
    </div>
  );
}

export default function PortfolioCommandCenter() {
  const [unlocked, setUnlocked] = useState(false);
  const [holdings, setHoldings] = useState(INITIAL);
  const [prices, setPrices] = useState({});
  const [dominance, setDominance] = useState(null);
  const [status, setStatus] = useState("loading");
  const [lastUpdate, setLastUpdate] = useState(null);

  const [rsHist, setRsHist] = useState({});
  const [rsStatus, setRsStatus] = useState("idle");
  const [rsProgress, setRsProgress] = useState(0);
  const historyTimer = useRef(null);

  const [domTrend, setDomTrend] = useState("rising");
  const [btcTrend, setBtcTrend] = useState("up");
  const [macro, setMacro] = useState("risk-on");
  const [sizer, setSizer] = useState({ riskPct: 1.5, entry: 0, stop: 0 });

  useEffect(() => {
    if (!document.getElementById("df-fonts")) {
      const l = document.createElement("link"); l.id = "df-fonts"; l.rel = "stylesheet"; l.href = FONT_LINK;
      document.head.appendChild(l);
    }
  }, []);

  const cryptoCgIds = useMemo(() => [...new Set(holdings.filter((h) => h.cgId && h.bucket === "crypto").map((h) => h.cgId))], [holdings]);
  const allCgIds = useMemo(() => [...new Set(holdings.filter((h) => h.cgId).map((h) => h.cgId))], [holdings]);

  const refreshPrices = useCallback(async () => {
    try {
      const [p, dom] = await Promise.all([fetchPrices(allCgIds), fetchDominance().catch(() => null)]);
      setPrices(p);
      if (dom != null) setDominance(dom);
      setStatus("live");
      setLastUpdate(new Date());
    } catch {
      setStatus((s) => (Object.keys(prices).length ? "stale" : "loading"));
    }
  }, [allCgIds, prices]);

  const refreshHistory = useCallback(async () => {
    setRsStatus("loading");
    setRsProgress(0);
    const next = {};
    let ok = 0;
    const ordered = ["bitcoin", ...cryptoCgIds.filter((id) => id !== "bitcoin")];
    for (let i = 0; i < ordered.length; i++) {
      const cgId = ordered[i];
      try {
        const series30 = await fetchHistory(cgId, 30);
        const tail = (n) => series30.slice(Math.max(0, series30.length - (n + 1)));
        next[cgId] = {
          d7: pctChange(tail(7)),
          d14: pctChange(tail(14)),
          d30: pctChange(series30),
        };
        ok++;
      } catch {
        if (rsHist[cgId]) next[cgId] = rsHist[cgId];
      }
      setRsProgress(Math.round(((i + 1) / ordered.length) * 100));
      if (i < ordered.length - 1) await sleep(STAGGER_MS);
    }
    setRsHist(next);
    setRsStatus(ok === ordered.length ? "ready" : "partial");
  }, [cryptoCgIds, rsHist]);

  useEffect(() => {
    if (!unlocked) return;
    refreshPrices();
    refreshHistory();
    const priceT = setInterval(refreshPrices, PRICE_REFRESH_MS);
    historyTimer.current = setInterval(refreshHistory, HISTORY_REFRESH_MS);
    return () => { clearInterval(priceT); clearInterval(historyTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  const priceOf = useCallback((h) => (h.cgId && prices[h.cgId] ? prices[h.cgId].usd : h.manualPrice ?? 0), [prices]);
  const change24Of = useCallback((h) => (h.cgId && prices[h.cgId] ? prices[h.cgId].usd_24h_change ?? null : null), [prices]);
  const valueOf = useCallback((h) => priceOf(h) * h.qty, [priceOf]);

  const enriched = useMemo(() => holdings.map((h) => ({ ...h, price: priceOf(h), value: valueOf(h), change24: change24Of(h) })), [holdings, priceOf, valueOf, change24Of]);
  const total = useMemo(() => enriched.reduce((s, h) => s + h.value, 0), [enriched]);
  const byBucket = useMemo(() => { const b = { crypto: 0, stable: 0, equity: 0 }; enriched.forEach((h) => (b[h.bucket] += h.value)); return b; }, [enriched]);
  const cryptoTotal = byBucket.crypto;
  const btcVal = useMemo(() => enriched.find((h) => h.ticker === "BTC")?.value || 0, [enriched]);
  const btcPctOfCrypto = cryptoTotal ? (btcVal / cryptoTotal) * 100 : 0;
  const btcHist = rsHist["bitcoin"];

  const regime = useMemo(() => computeRegime({ dominance: domTrend, btcTrend, macro }), [domTrend, btcTrend, macro]);
  const sized = useMemo(() => sizePosition({ account: total, riskPct: sizer.riskPct, entry: +sizer.entry, stop: +sizer.stop }), [total, sizer]);

  const setQty = (id, qty) => setHoldings((hs) => hs.map((h) => (h.id === id ? { ...h, qty: +qty || 0 } : h)));
  const setManualPrice = (id, mp) => setHoldings((hs) => hs.map((h) => (h.id === id ? { ...h, manualPrice: +mp || 0 } : h)));

  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />;

  const statusColor = status === "live" ? C.green : status === "stale" ? C.amber : C.dim;
  const sortedCrypto = [...enriched].filter((h) => h.bucket === "crypto").sort((a, b) => b.value - a.value);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink, fontFamily: "'Inter', sans-serif" }}>
      <div style={{ position: "fixed", top: -200, left: "50%", transform: "translateX(-50%)", width: 700, height: 400, background: `radial-gradient(ellipse, ${C.blue}22, transparent 70%)`, pointerEvents: "none", zIndex: 0 }} />
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 20px 80px", position: "relative", zIndex: 1 }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 10 }}>
          <div>
            <div style={{ fontFamily: "'Oxanium', sans-serif", fontWeight: 800, fontSize: 28, letterSpacing: 1 }}>PORTFOLIO COMMAND CENTER</div>
            <div style={{ color: C.cyan, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, letterSpacing: 2 }}>DIGITAL FRONTIER · LEVEL 2.5 · TREND RS</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <Label>Total Portfolio</Label>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 32 }}>{fmtUSD(total)}</div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", flexWrap: "wrap" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor }} />
          <span style={{ color: statusColor }}>{status === "live" ? "PRICES LIVE" : status === "stale" ? "PRICES STALE — last good shown" : "LOADING…"}</span>
          {lastUpdate && <span style={{ color: C.dim }}>· {lastUpdate.toLocaleTimeString()}</span>}
          {dominance != null && <span style={{ color: C.dim }}>· BTC.D {dominance.toFixed(1)}%</span>}
          <span style={{ color: C.dim }}>· trend: {rsStatus === "loading" ? `loading ${rsProgress}%` : rsStatus === "ready" ? "ready" : rsStatus === "partial" ? "partial" : "—"}</span>
          <button onClick={() => { refreshPrices(); refreshHistory(); }} style={{ marginLeft: "auto", background: C.panel2, border: `1px solid ${C.line}`, color: C.ink, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>refresh all</button>
        </div>

        <Panel style={{ marginBottom: 18, borderColor: regime.color }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
            <Label>Weekly Regime Verdict</Label>
            <span style={{ fontFamily: "'Oxanium', sans-serif", fontWeight: 800, fontSize: 20, color: regime.color, letterSpacing: 2 }}>{regime.state}</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{regime.headline}</div>
          <div style={{ color: C.dim, fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>{regime.detail}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            <Selector label="BTC Dominance Trend" value={domTrend} setValue={setDomTrend} options={["rising", "flat", "falling"]} />
            <Selector label="BTC Trend" value={btcTrend} setValue={setBtcTrend} options={["up", "sideways", "down"]} />
            <Selector label="42 Macro Regime" value={macro} setValue={setMacro} options={["risk-on", "neutral", "risk-off"]} />
          </div>
        </Panel>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
          <Panel>
            <Label>Allocation by Bucket</Label>
            <BucketBar byBucket={byBucket} total={total} />
            <div style={{ marginTop: 16 }}>
              <Row k="Crypto" v={fmtUSD(byBucket.crypto)} pct={total ? (byBucket.crypto / total) * 100 : 0} color={C.blue} />
              <Row k="Stables / Cash" v={fmtUSD(byBucket.stable)} pct={total ? (byBucket.stable / total) * 100 : 0} color={C.cyan} />
              <Row k="Equities" v={fmtUSD(byBucket.equity)} pct={total ? (byBucket.equity / total) * 100 : 0} color={C.amber} />
            </div>
          </Panel>
          <Panel>
            <Label>BTC Concentration (of crypto)</Label>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 40, fontWeight: 600, color: btcPctOfCrypto > 70 ? C.amber : C.ink }}>{btcPctOfCrypto.toFixed(1)}%</div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: btcPctOfCrypto > 70 ? C.amber : C.dim, marginTop: 8 }}>
              {btcPctOfCrypto > 70 ? "High concentration. Fine in DEFEND; in ROTATE the system pushes measured moves into RS-leading alts." : "Concentration in a reasonable band."}
            </div>
          </Panel>
        </div>

        <Panel style={{ marginBottom: 18 }}>
          <Label>Positions — Detailed Breakdown</Label>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ color: C.dim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 1 }}>
                <th style={th}>ASSET</th>
                <th style={{ ...th, textAlign: "right" }}>PRICE</th>
                <th style={{ ...th, textAlign: "right" }}>QTY</th>
                <th style={{ ...th, textAlign: "right" }}>VALUE</th>
                <th style={{ ...th, textAlign: "right" }}>% CRYPTO</th>
                <th style={{ ...th, textAlign: "right" }}>% TOTAL</th>
                <th style={{ ...th, textAlign: "right" }}>24H</th>
                <th style={{ ...th, textAlign: "right" }}>WEIGHT</th>
              </tr>
            </thead>
            <tbody>
              {sortedCrypto.map((h) => {
                const pctCrypto = cryptoTotal ? (h.value / cryptoTotal) * 100 : 0;
                const pctTotal = total ? (h.value / total) * 100 : 0;
                return (
                  <tr key={h.id} style={{ borderTop: `1px solid ${C.line}` }}>
                    <td style={{ ...td, fontWeight: 600 }}>{h.ticker}<span style={{ color: C.dim, fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{h.name}</span></td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: C.dim }}>{h.price ? fmtUSD(h.price) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: C.dim }}>{h.qty}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmtUSD(h.value)}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{fmtPct(pctCrypto)}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: C.dim }}>{fmtPct(pctTotal)}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: h.change24 == null ? C.dim : h.change24 >= 0 ? C.green : C.red }}>{fmtSigned(h.change24)}</td>
                    <td style={{ ...td, width: 90 }}><WeightBar pct={pctCrypto} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        <Panel style={{ marginBottom: 18 }}>
          <Label>Relative Strength — Multi-Week Trend vs BTC</Label>
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 4 }}>
            Blended score = weighted outperformance vs BTC across 7d (25%), 14d (35%), 30d (40%). Positive = out-trending BTC.
          </div>
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 14 }}>
            BTC trend — 7d: <Mono v={btcHist?.d7} /> · 14d: <Mono v={btcHist?.d14} /> · 30d: <Mono v={btcHist?.d30} />
          </div>
          {rsStatus === "loading" && Object.keys(rsHist).length === 0 ? (
            <div style={{ color: C.dim, fontSize: 13, padding: "12px 0" }}>Loading multi-week history… {rsProgress}% (staggered to respect API limits)</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ color: C.dim, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: 1 }}>
                  <th style={th}>ASSET</th>
                  <th style={{ ...th, textAlign: "right" }}>7D</th>
                  <th style={{ ...th, textAlign: "right" }}>14D</th>
                  <th style={{ ...th, textAlign: "right" }}>30D</th>
                  <th style={{ ...th, textAlign: "right" }}>RS SCORE</th>
                  <th style={th}>VERDICT</th>
                  <th style={{ ...th, textAlign: "right" }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {RS_ALTS.map((t) => {
                  const h = holdings.find((x) => x.ticker === t);
                  const altHist = h && rsHist[h.cgId];
                  const { score } = blendedRS(altHist, btcHist);
                  const v = rsVerdictFromScore(score);
                  return (
                    <tr key={t} style={{ borderTop: `1px solid ${C.line}` }}>
                      <td style={{ ...td, fontWeight: 600 }}>{t}</td>
                      <td style={{ ...td, textAlign: "right" }}><Mono v={altHist?.d7} /></td>
                      <td style={{ ...td, textAlign: "right" }}><Mono v={altHist?.d14} /></td>
                      <td style={{ ...td, textAlign: "right" }}><Mono v={altHist?.d30} /></td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: score == null ? C.dim : score > 0 ? C.green : C.red }}>
                        {score == null ? "—" : `${score >= 0 ? "+" : ""}${score.toFixed(1)}`}
                      </td>
                      <td style={td}><span style={{ color: v.color, fontWeight: 600, fontSize: 12 }}>{v.label}</span></td>
                      <td style={{ ...td, textAlign: "right", color: v.color, fontSize: 13 }}>{v.action}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div style={{ color: C.dim, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            RS SCORE = weighted-average percentage points the alt beat (or lagged) BTC across the three windows. Thresholds: &gt;+3 OUTPERFORM, &lt;−3 UNDERPERFORM, between = NEUTRAL. History refreshes every 10 min.
          </div>
        </Panel>

        <Panel style={{ marginBottom: 18 }}>
          <Label>Risk-Structured Position Sizer</Label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14, marginBottom: 14 }}>
            <Field label="Risk % of portfolio" value={sizer.riskPct} onChange={(x) => setSizer((s) => ({ ...s, riskPct: +x }))} />
            <Field label="Entry price" value={sizer.entry} onChange={(x) => setSizer((s) => ({ ...s, entry: +x }))} />
            <Field label="Stop-loss price" value={sizer.stop} onChange={(x) => setSizer((s) => ({ ...s, stop: +x }))} />
          </div>
          {sized ? (
            <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
              <Stat label="Risk amount" value={fmtUSD(sized.riskAmt)} color={C.amber} />
              <Stat label="Size (units)" value={sized.units.toFixed(4)} color={C.cyan} />
              <Stat label="Notional" value={fmtUSD(sized.notional)} color={C.ink} />
              <Stat label="Risk / unit" value={fmtUSD(sized.perUnitRisk)} color={C.dim} />
            </div>
          ) : <div style={{ color: C.dim, fontSize: 14 }}>Enter entry and a different stop to compute size.</div>}
          <div style={{ color: C.dim, fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>Never risk more than 1–2% of the book per trade. Size = (risk $) ÷ (entry − stop). Risk base auto-uses your live total.</div>
        </Panel>

        <Panel>
          <Label>Edit Holdings — enter your real quantities once</Label>
          <div style={{ fontSize: 12, color: C.dim, marginBottom: 14 }}>Crypto: enter number of coins (price live). Equities/Cash: enter dollar value (qty stays 1).</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10 }}>
            {holdings.map((h) => (
              <div key={h.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 56, fontWeight: 600, fontSize: 13 }}>{h.ticker}</span>
                {h.cgId ? (
                  <><span style={{ flex: 1, color: C.dim, fontSize: 11 }}>qty</span>
                  <input type="number" value={h.qty} onChange={(e) => setQty(h.id, e.target.value)} style={{ ...miniInput, width: 110 }} /></>
                ) : (
                  <><span style={{ flex: 1, color: C.dim, fontSize: 11 }}>$ value</span>
                  <input type="number" value={h.manualPrice ?? 0} onChange={(e) => setManualPrice(h.id, e.target.value)} style={{ ...miniInput, width: 110 }} /></>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <div style={{ color: C.dim, fontSize: 11, marginTop: 24, lineHeight: 1.6, fontFamily: "'IBM Plex Mono', monospace" }}>
          // LEVEL 3 PATH: read-only exchange/wallet API for auto balances; persist
          // rsHist to localStorage so trend survives refresh; add a serverless proxy
          // if CoinGecko CORS/rate-limits bite once deployed.
        </div>
      </div>
    </div>
  );
}

const miniInput = { width: 80, padding: "6px 8px", background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, outline: "none" };
const th = { textAlign: "left", padding: "6px 4px", fontWeight: 500 };
const td = { padding: "10px 4px" };

function Mono({ v }) {
  return <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: v == null ? C.dim : v >= 0 ? C.green : C.red, fontSize: 13 }}>{fmtSigned(v)}</span>;
}
function Selector({ label, value, setValue, options }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1 }}>{label.toUpperCase()}</div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((o) => (
          <button key={o} onClick={() => setValue(o)} style={{ flex: 1, padding: "7px 4px", fontSize: 12, cursor: "pointer", background: value === o ? C.blue : C.panel2, color: value === o ? "#fff" : C.dim, border: `1px solid ${value === o ? C.blue : C.line}`, borderRadius: 6, fontWeight: 500 }}>{o}</button>
        ))}
      </div>
    </div>
  );
}
function BucketBar({ byBucket, total }) {
  const seg = (v, color) => ({ width: total ? `${(v / total) * 100}%` : "0%", background: color, height: "100%" });
  return (
    <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: C.panel2 }}>
      <div style={seg(byBucket.crypto, C.blue)} /><div style={seg(byBucket.stable, C.cyan)} /><div style={seg(byBucket.equity, C.amber)} />
    </div>
  );
}
function WeightBar({ pct }) {
  return <div style={{ height: 8, background: C.panel2, borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: C.blue }} /></div>;
}
function Row({ k, v, pct, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
      <span style={{ flex: 1, fontSize: 14 }}>{k}</span>
      <span style={{ color: C.dim, fontSize: 13, fontFamily: "'IBM Plex Mono', monospace" }}>{fmtPct(pct)}</span>
      <span style={{ width: 100, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>{v}</span>
    </div>
  );
}
function Field({ label, value, onChange }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1 }}>{label.toUpperCase()}</div>
      <input type="number" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...miniInput, width: "100%" }} />
    </div>
  );
}
function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: C.dim, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 1 }}>{label.toUpperCase()}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}
