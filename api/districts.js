const { pulse, send, toInt } = require("./_pulse");

module.exports = async (req, res) => {
  const id = toInt(req.query.division_id);
  if (id == null) return send(res, 400, { error: "division_id required" });
  try {
    const rows = await pulse(`/Admins/filterDistricts/${id}.00000000`);
    const out = rows.map((r) => ({ id: Math.round(Number(r.id)), name: r.name, extent: r.extent }));
    send(res, 200, out, "public, s-maxage=86400, stale-while-revalidate=86400");
  } catch (e) {
    send(res, 502, { error: e.message }, "no-store");
  }
};
