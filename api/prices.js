// Serverless proxy for CoinGecko simple/price.
// No secret key needed — benefit is server-side caching and avoiding
// browser CORS / rate-limit issues on the free tier.

export default async function handler(req, res) {
  const { ids = "", vs = "usd" } = req.query;
  if (!ids) return res.status(400).json({ error: "missing ids" });

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${vs}&include_24hr_change=true`;
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).json({ error: "upstream" });
    const data = await upstream.json();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: "fetch_failed", detail: String(e) });
  }
}
