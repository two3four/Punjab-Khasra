// Short-lived ArcGIS token, obtained the same way the PULSE map page does.
const { pulse, send } = require("./_pulse");

module.exports = async (req, res) => {
  try {
    const d = await pulse("/api/gis/token");
    if (!d || !d.token) return send(res, 502, { error: "PULSE returned no token" }, "no-store");
    send(res, 200, { token: d.token, expiresAt: d.expiresAt || null }, "public, s-maxage=600, stale-while-revalidate=300");
  } catch (e) {
    send(res, 502, { error: "Could not reach lis.pulse.gop.pk: " + e.message }, "no-store");
  }
};
