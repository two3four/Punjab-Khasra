"""Local test harness: serves public/ + fake /api on one origin, with the mock GIS server mounted at /mock."""
import sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "local"))
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from tests import mock_upstream as mock  # local/tests/mock_upstream.py

app = FastAPI()
app.mount("/mock", mock.app)

@app.get("/api/token")
def token(): return {"token": "MOCKTOKEN", "expiresAt": None}

@app.get("/api/districts")
def districts(division_id: int): return [{"id": int(d["id"]), "name": d["name"], "extent": d["extent"]} for d in mock.districts(str(division_id))]

@app.get("/api/tehsils")
def tehsils(district_id: int): return [{"id": int(t["id"]), "name": t["name"], "extent": t["extent"]} for t in mock.tehsils(district_id)]

@app.get("/")
def index():
    html = (ROOT / "public/index.html").read_text()
    inj = '<script>window.PCK_CONFIG={gis:location.origin+"/mock/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer"};</script>'
    return HTMLResponse(html.replace('<script src="/app.js">', inj + '<script src="/app.js">'))

app.mount("/", StaticFiles(directory=str(ROOT / "public")), name="static")
