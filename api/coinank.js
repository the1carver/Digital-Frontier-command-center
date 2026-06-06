// Serverless proxy for CoinAnk OpenAPI.
// The API key lives ONLY here, read from the environment. Never in the browser.
//
// VERIFIED FROM OFFICIAL DOCS (github.com/coinank/coinank-openapi-skill):
//   - Base URL:  https://open-api.coinank.com
//   - Auth:      header  apikey: <your_key>
//   - Method:    all GET
//   - Success:   { "success": true, "code": "1", "data": ... }
//   - Errors:    code "-3" = bad/invalid key,  "-7" = bad endTime timestamp
//
// The browser calls:  /api/coinank?signal=altseason
// This function maps that to the real endpoint, injects the key + a FRESH
// millisecond timestamp, and returns JSON.

const BASE = "https://open-api.coinank.com";

const SIGNALS = {
  // --- Indicators (API1) ---
  altseason:    { path: "/api/indicator/getAltcoinSeason" },
  feargreed:    { path: "/api/indicator/getCnnEntity" },
  ahr999:       { path: "/api/indicator/getAhr999" },
  picycle:      { path: "/api/indicator/getBtcPi" },
  puell:        { path: "/api/indicator/getPuellMultiple" },
  ma2y:         { path: "/api/indicator/getBtcMultiplier" },
  // --- Funding rate (API1) ---
  funding:      { path: "/api/fundingRate/current", defaults: { type: "current" } },
  fundingWtd:   { path: "/api/fundingRate/getWeiFr", needsTime: true,
                  defaults: { baseCoin: "BTC", interval: "1h", size: "10" } },
  // --- Open interest (API1) ---
  oiAll:        { path: "/api/openInterest/all", defaults: { baseCoin: "BTC" } },
  oiChart:      { path: "/api/openInterest/v2/chart", needsTime: true,
                  defaults: { baseCoin: "BTC", exchange: "", interval: "1h", size: "30", type: "USD" } },
  // --- Liquidations (API1) ---
  liqIntervals: { path: "/api/liquidation/allExchange/intervals", defaults: { baseCoin: "BTC" } },
  // --- Long/short realtime (API1) ---
  longshort:    { path: "/api/longshort/realtimeAll", defaults: { baseCoin: "BTC", interval: "1h" } },
  // --- Rankings (API2) ---
  oiRank:       { path: "/api/instruments/oiRank", defaults: { sortBy: "openInterest", sortType: "desc", size: "20", page: "1" } },
  priceRank:    { path: "/api/instruments/priceRank", defaults: { sortBy: "priceChangeH24", sortType: "desc" } },
  // --- RSI screener (API2) ---
  rsi:          { path: "/api/rsiMap/list", defaults: { interval: "1H", exchange: "Binance" } },
};

export default async function handler(req, res) {
  const { signal = "", ...overrides } = req.query;
  const key = process.env.COINANK_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing COINANK_API_KEY" });

  const cfg = SIGNALS[signal];
  if (!cfg) return res.status(400).json({ error: `Unknown signal: ${signal}`, available: Object.keys(SIGNALS) });

  const params = { ...(cfg.defaults || {}), ...overrides };
  if (cfg.needsTime || "endTime" in params) params.endTime = String(Date.now());

  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${cfg.path}${qs ? "?" + qs : ""}`;

  try {
    const upstream = await fetch(url, {
      headers: { apikey: key, "Content-Type": "application/json" },
    });
    const text = await upstream.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }

    if (body && body.code === "-3") return res.status(403).json({ error: "auth_or_tier", code: "-3" });
    if (body && body.code === "-7") return res.status(400).json({ error: "bad_timestamp", code: "-7" });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "upstream", detail: text.slice(0, 200) });

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(text);
  } catch (e) {
    return res.status(502).json({ error: "fetch_failed", detail: String(e) });
  }
}
