"""Export cached parcels as Shapefile (zip) or CSV."""
import csv
import io
import json
import zipfile

import shapefile  # pyshp

from .store import fmt_area

PRJ_WGS84 = ('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
             'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]')

# (source attribute, dbf name <=10 chars, type)
FIELDS = [
    ("OBJECTID", "OBJECTID", "N"), ("District", "District", "C"), ("Dist_ID", "Dist_ID", "C"),
    ("Tehsil", "Tehsil", "C"), ("Tehsil_ID", "Tehsil_ID", "N"), ("QH", "QH", "C"), ("QH_ID", "QH_ID", "C"),
    ("PC", "PC", "C"), ("PC_ID", "PC_ID", "C"), ("Mouza", "Mouza", "C"), ("Mouza_ID", "Mouza_ID", "C"),
    ("Type", "Type", "C"), ("M", "M", "C"), ("A", "A", "N"), ("K", "K", "C"), ("SK", "SK", "C"),
    ("Label", "Label", "C"), ("MK", "MK", "C"), ("Khewat_No", "Khewat_No", "C"),
    ("Khatuni_No", "Khatuni_No", "C"), ("Khasra_ID", "Khasra_ID", "N"), ("MN", "MN", "N"), ("B", "B", "C"),
    ("Remarks", "Remarks", "C"), ("Karam", "Karam", "F"), ("Khewat_ID", "Khewat_ID", "N"),
    ("Join_Shp", "Join_Shp", "C"), ("propstatus", "propstatus", "N"),
    ("_area_m2", "Area_m2", "F"), ("_area_KM", "Area_KM", "C"),
]


def _signed(r):
    return sum((r[i + 1][0] - r[i][0]) * (r[i + 1][1] + r[i][1]) for i in range(len(r) - 1))


def _shp_rings(g):
    """Rings with shapefile winding: outer clockwise, holes counter-clockwise."""
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    out = []
    for p in polys:
        for i, ring in enumerate(p):
            ring = [list(pt[:2]) for pt in ring]
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
            cw = _signed(ring) > 0
            if (i == 0 and not cw) or (i > 0 and cw):
                ring.reverse()
            out.append(ring)
    return out


def _rows(store, layer_id, tehsil_id, mouza_id):
    for r in store.features_sql(layer_id, tehsil_id, mouza_id):
        p = json.loads(r["props"])
        p["_area_m2"] = round(r["area_m2"] or 0, 2)
        p["_area_KM"] = fmt_area(r["area_m2"])
        yield r, p


def to_shapefile_zip(store, layer_id, tehsil_id, mouza_id, basename):
    rows = list(_rows(store, layer_id, tehsil_id, mouza_id))
    shp, shx, dbf = io.BytesIO(), io.BytesIO(), io.BytesIO()
    w = shapefile.Writer(shp=shp, shx=shx, dbf=dbf, shapeType=shapefile.POLYGON, encoding="utf-8")
    for src, name, typ in FIELDS:
        if typ == "C":
            size = max([len(str(p.get(src) or "").encode("utf-8")) for _, p in rows] + [1])
            w.field(name, "C", size=min(size, 254))
        elif typ == "N":
            w.field(name, "N", size=12, decimal=0)
        else:
            w.field(name, "N", size=19, decimal=4)
    for r, p in rows:
        w.poly(_shp_rings(json.loads(r["geom"])))
        rec = []
        for src, _, typ in FIELDS:
            v = p.get(src)
            if typ == "C":
                rec.append("" if v is None else str(v))
            else:
                try:
                    rec.append(None if v in (None, "") else (int(v) if typ == "N" else float(v)))
                except (TypeError, ValueError):
                    rec.append(None)
        w.record(*rec)
    w.close()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(basename + ".shp", shp.getvalue())
        z.writestr(basename + ".shx", shx.getvalue())
        z.writestr(basename + ".dbf", dbf.getvalue())
        z.writestr(basename + ".prj", PRJ_WGS84)
        z.writestr(basename + ".cpg", "UTF-8")
    return out.getvalue()


def to_csv(store, layer_id, tehsil_id, mouza_id):
    buf = io.StringIO()
    cols = [f[0] for f in FIELDS] + ["centroid_lon", "centroid_lat"]
    wr = csv.writer(buf)
    wr.writerow([c.lstrip("_") for c in cols])
    for r, p in _rows(store, layer_id, tehsil_id, mouza_id):
        p["centroid_lon"], p["centroid_lat"] = r["cx"], r["cy"]
        wr.writerow(["" if p.get(c) is None else p.get(c) for c in cols])
    return ("﻿" + buf.getvalue()).encode("utf-8")
