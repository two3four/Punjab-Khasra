"""Fake PULSE + ArcGIS server for offline testing. Run: uvicorn tests.mock_upstream:app --port 9001"""
import json
import random

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
SVC = "/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer"
LAYERS = [{"id": 15, "name": "Khushab", "subLayerIds": None}, {"id": 30, "name": "Sargodha", "subLayerIds": None}]
MAUZAS = [("38944", "Adlial", 72.10, 32.55, 2300), ("38824", "Ahmadabad", 72.28, 32.61, 900), ("97910", "Anga", 72.06, 32.59, 4100)]
FEATS = []


def build():
    FEATS.clear()
    oid = 1000
    for mid, name, x0, y0, n in MAUZAS:
        side = int(n ** 0.5) + 1
        d = 0.0006
        for i in range(n):
            r, c = divmod(i, side)
            x, y = x0 + c * d, y0 + r * d
            oid += 1
            FEATS.append({"type": "Feature", "id": oid, "geometry": {"type": "Polygon", "coordinates": [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]]},
                          "properties": {"OBJECTID": oid, "District": "Khushab", "Dist_ID": "19", "Tehsil": "Noshera", "Tehsil_ID": 64,
                                         "QH": "Naushehra", "QH_ID": "425", "PC": name, "PC_ID": "34", "Mouza": name, "Mouza_ID": mid,
                                         "Type": "MT", "M": "0", "A": 6, "K": str(c % 25 + 1), "SK": " ", "Label": f"{r + 1}/{c % 25 + 1}",
                                         "MK": None, "Khewat_No": None, "Khatuni_No": None, "Khasra_ID": 70000000 + oid, "MN": r + 1,
                                         "B": None, "Remarks": " ", "Karam": 5.5, "Khewat_ID": 5400000 + oid % 900, "Join_Shp": f"{r + 1}/{c % 25 + 1}",
                                         "propstatus": None, "Shape.STArea()": 5627.6, "Shape.STLength()": 300.4}})


build()


@app.get("/api/gis/token")
def token():
    return {"success": True, "token": "MOCKTOKEN", "expiresAt": "2099-01-01T00:00:00", "error": None}


@app.get("/Admins/filterDistricts/{div}")
def districts(div: str):
    return [{"id": 19.0, "name": "Khushab", "division": "Sargodha", "extent": "71.609837274,31.529329387,72.6324598,32.728494304"},
            {"id": 31.0, "name": "Sargodha", "division": "Sargodha", "extent": "72.195805712,31.570982989,73.299354259,32.590133499"}]


@app.get("/Admins/filterTehsils/{dist}")
def tehsils(dist: int):
    return [{"id": 64.0, "name": "Noshera", "extent": "71.844367658,32.455902453,72.400984654,32.728494304"},
            {"id": 63.0, "name": "Khushab", "extent": "71.985913614,31.983879759,72.6324598,32.688463941"}]


@app.post("/mock/mutate")
def mutate():
    """Simulate a server update: edit 5 parcels, delete 3, add 2."""
    random.seed(1)
    for f in random.sample(FEATS, 5):
        f["properties"]["Remarks"] = "Updated"
    for f in random.sample(FEATS, 3):
        FEATS.remove(f)
    for k in range(2):
        f = json.loads(json.dumps(FEATS[k]))
        f["id"] = f["properties"]["OBJECTID"] = 999000 + k
        f["properties"]["Khasra_ID"] = 99990000 + k
        f["properties"]["Label"] = f"NEW/{k}"
        FEATS.append(f)
    return {"ok": True}


@app.get(SVC)
def service(token: str = None):
    return {"layers": LAYERS, "maxRecordCount": 2000}


def _filter(where):
    w = where.replace(" ", "")
    out = FEATS
    if "Tehsil_ID=" in w:
        t = int(w.split("Tehsil_ID=")[1].split("AND")[0])
        out = [f for f in out if f["properties"]["Tehsil_ID"] == t]
    if "Mouza_ID='" in w:
        m = w.split("Mouza_ID='")[1].split("'")[0]
        out = [f for f in out if f["properties"]["Mouza_ID"] == m]
    return out


@app.get(SVC + "/{lid}/query")
def query(lid: int, request: Request):
    q = dict(request.query_params)
    if q.get("token") != "MOCKTOKEN":
        return {"error": {"code": 499, "message": "Token Required"}}
    feats = _filter(q.get("where", "1=1")) if lid == 15 else []
    if q.get("returnCountOnly") == "true":
        return {"count": len(feats)}
    if q.get("groupByFieldsForStatistics"):
        agg = {}
        for f in feats:
            k = (f["properties"]["Mouza_ID"], f["properties"]["Mouza"])
            agg[k] = agg.get(k, 0) + 1
        return {"features": [{"attributes": {"Mouza_ID": k[0], "Mouza": k[1], "n": v}} for k, v in agg.items()]}
    if q.get("returnDistinctValues") == "true":
        fields = q["outFields"].split(",")
        seen = {tuple(f["properties"][x] for x in fields) for f in feats}
        return {"features": [{"attributes": dict(zip(fields, s))} for s in seen]}
    feats = sorted(feats, key=lambda f: f["properties"]["OBJECTID"])
    off, n = int(q.get("resultOffset", 0)), int(q.get("resultRecordCount", 2000))
    page = feats[off:off + min(n, 2000)]
    return JSONResponse({"type": "FeatureCollection", "features": page,
                         "properties": {"exceededTransferLimit": off + len(page) < len(feats)}})
