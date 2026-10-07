# Punjab Cadastral Explorer

Your own local web app for the Punjab cadastral (khasra) maps shown on lis.pulse.gop.pk.

- **Browse** Division → District → Tehsil → Mauza, the same way the PULSE site works.
- **On-demand:** when you open a mauza for the first time, it is downloaded live from the Punjab Zameen GIS server and saved in a local database. After that it opens instantly, even offline.
- **Auto-sync:** every cached mauza is downloaded again every 24 hours. Parcels that were added, edited or removed on the server are logged on the Dashboard.
- **Map:** satellite or street basemap, khasra labels at close zoom, and a click on any parcel shows all its attributes plus its area in Kanal-Marla.
- **Search** cached parcels by khasra label (e.g. `10/6`), Khasra ID or Khewat ID.
- **Export** a mauza or a whole tehsil as Shapefile, GeoJSON or CSV (WGS84).
- **Cache whole tehsil** downloads every mauza of a tehsil in the background.

## Start it (Windows)

1. Install Python 3.10 or newer from python.org and tick **"Add python.exe to PATH"**.
2. Unzip this folder somewhere, e.g. `D:\PulseCadastral`.
3. Double-click **run.bat**. The first start installs what it needs, which takes about a minute.
4. Your browser opens **http://localhost:8000**.

Keep the black window open. Auto-sync only runs while the app is running.

To start it automatically when Windows starts: press `Win+R`, type `shell:startup`, and put a shortcut to `run.bat` in that folder.

## Settings

Copy `config.env.example` to `config.env` and edit it:

| Setting | Default | Meaning |
|---|---|---|
| `REFRESH_HOURS` | 24 | Re-download cached mauzas after this many hours |
| `MAX_CONCURRENCY` / `REQUEST_DELAY` | 2 / 0.4 s | How hard the app hits the server. Keep these low. |
| `HOST` | 127.0.0.1 | Set `0.0.0.0` to let colleagues on your network open `http://<your-PC-IP>:8000` |
| `DB_PATH` | `data\cadastral.db` | Location of the cache database |

## How it gets the data

- Admin lists (districts and tehsils) come from `lis.pulse.gop.pk/Admins/...`.
- Parcels come from `gismaps.punjab-zameen.gov.pk/.../VendorMaps/Punjab_Cdastral_Maps/MapServer`, which has one layer per district. Mauzas are loaded 2,000 parcels per request.
- The server wants a short-lived token. The app gets it from `lis.pulse.gop.pk/api/gis/token`, which is what the PULSE web page itself does, and renews it automatically.
- Change detection compares each parcel (by Khasra_ID) with the previous download, using a fingerprint of its attributes and geometry.

**If it stops working**, the PULSE or GIS server has probably changed its URLs or token rules. The Auto-sync tab shows the last server error.

## Important: permissions and public use

This is not an official API. The data belongs to the Punjab Land Records Authority (PLRA) / PULSE.

- For personal or internal use, keep the default gentle request rate.
- **Before putting this on the public internet, get written permission from PLRA/PULSE.** A public site that republishes land records, and that forwards every visitor's request through the PULSE token, could break their terms and get your server blocked.
- Area values are computed from the WGS84 geometry and are approximate. For legal measurements, use the official Fard and Aks-Shajra.

## Files

```
app/main.py        web server, API, background jobs, 24h scheduler
app/upstream.py    talks to PULSE + ArcGIS (token, paging, retries)
app/store.py       SQLite cache, change detection, area (Kanal/Marla)
app/exporters.py   Shapefile and CSV export
static/            the map dashboard (Leaflet from cdnjs)
tests/mock_upstream.py  fake server for offline testing
```

API docs while running: http://localhost:8000/docs
