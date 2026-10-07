// Shared helper for calling lis.pulse.gop.pk from Vercel functions (PULSE has no CORS for other sites).
const BASE = (process.env.PULSE_BASE || "https://lis.pulse.gop.pk").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

async function pulse(path) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path, {
        headers: { "User-Agent": UA, Referer: BASE + "/", Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error("PULSE HTTP " + r.status);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 600 * (i + 1)));
    }
  }
  throw last;
}

function send(res, status, body, cache) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.status(status).send(JSON.stringify(body));
}

const toInt = (v) => (/^\d{1,6}$/.test(String(v || "")) ? parseInt(v, 10) : null);

module.exports = { pulse, send, toInt };
