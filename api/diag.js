// Connectivity check from the Vercel function region (open /api/diag).
module.exports = async (req, res) => {
  const targets = {
    pulse_token: "https://lis.pulse.gop.pk/api/gis/token",
    pulse_home: "https://lis.pulse.gop.pk/",
    gis: "https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services?f=json",
    control: "https://www.google.com/generate_204",
  };
  const out = { region: process.env.VERCEL_REGION || null };
  await Promise.all(Object.entries(targets).map(async ([k, u]) => {
    const t0 = Date.now();
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0" } });
      const body = await r.text();
      out[k] = { status: r.status, ms: Date.now() - t0, bytes: body.length };
    } catch (e) {
      out[k] = { error: String(e && (e.cause && e.cause.code || e.name || e.message)), ms: Date.now() - t0 };
    }
  }));
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
};
