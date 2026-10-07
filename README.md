# Punjab Khasra Explorer

A web map of the Punjab cadastral (khasra) parcels shown on [lis.pulse.gop.pk](https://lis.pulse.gop.pk), with exports and change tracking.

**Two versions live in this repo:**

| | Web (Vercel), the repo root | Local server, `local/` |
|---|---|---|
| Runs on | Vercel (static page + 3 small functions) | Your PC (Python, FastAPI) |
| Parcel data | Fetched live from the Punjab Zameen GIS server by the visitor's browser | Fetched by the server, cached in SQLite |
| Saved mauzas + 24h refresh + change log | Stored per visitor in the browser (IndexedDB) and refreshed while the page is open | Shared database, refreshed by a background scheduler |
| Exports (SHP / GeoJSON / CSV) | In the browser | On the server |

## Features

- Division → District → Tehsil → Mauza menus, matching PULSE.
- Parcel map on satellite or street basemap, khasra labels when zoomed in, and a click shows all attributes plus area in Kanal-Marla.
- Saves each opened mauza and re-downloads it every 24 hours. Dashboard lists parcels added, edited or removed on the server.
- Search saved parcels by khasra label, Khasra ID or Khewat ID.
- Export a mauza or a whole tehsil as Shapefile, GeoJSON or CSV (WGS84).

## Deploy on Vercel

1. In Vercel, choose **Add New → Project → Import** this GitHub repo.
2. Framework preset: **Other**. Leave build settings empty (`vercel.json` sets `public/` as the output folder).
3. Click **Deploy**.

Functions run in Vercel's default region (`iad1`). Don't pin them to Mumbai (`bom1`): outbound requests from there timed out in testing. Open `/api/diag` to check that the functions can reach PULSE and the GIS server.

| Path | What it does |
|---|---|
| `public/` | The app (Leaflet and JSZip load from cdnjs; no build step) |
| `api/token.js` | Gets the short-lived GIS token from PULSE (cached 10 min at the edge) |
| `api/districts.js`, `api/tehsils.js` | PULSE admin lists (cached 24 h) |

Optional environment variable: `PULSE_BASE`, which defaults to `https://lis.pulse.gop.pk`.

## Run the local server version

See [`local/README.md`](local/README.md). On Windows, double-click `local/run.bat`.

## Data source and permissions

- The data belongs to the **Punjab Land Records Authority (PLRA) / PULSE**. This is an unofficial viewer, not a legal record. Use the official Fard and Aks-Shajra for legal purposes.
- There is no public API. The app uses the same endpoints and token the PULSE map page uses, so it can stop working whenever PULSE changes them.
- **Running this as a public website republishes government land records. Get PLRA/PULSE permission before promoting it publicly.**
- Areas are computed from the WGS84 geometry and are approximate.

## Tests

`tests/harness.py` serves the web app against a mock GIS server:

```
pip install fastapi uvicorn
uvicorn tests.harness:app --port 9100
```

Then open http://localhost:9100. `tests/test_api.js` exercises the Vercel functions.
