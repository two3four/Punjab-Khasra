"""Punjab Cadastral Explorer: FastAPI server with on-demand fetching, local cache and 24-hour auto refresh."""
import asyncio
import itertools
import logging
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, exporters
from .store import Store
from .upstream import Upstream, UpstreamError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

store: Store = None
up: Upstream = None
JOBS = {}
_job_ids = itertools.count(1)
_mauza_locks = {}
SCHED = {"next_check": None, "running": False, "last_check": None}


# ---------------------------------------------------------------- fetching
def _lock(key):
    return _mauza_locks.setdefault(key, asyncio.Lock())


async def fetch_mauza(meta, progress=None):
    """Download one mauza from the server and store it. Returns (added, changed, removed)."""
    key = (meta["layer_id"], meta["tehsil_id"], str(meta["mouza_id"]))
    async with _lock(key):
        try:
            feats = await up.mauza_features(meta["layer_id"], meta["tehsil_id"], meta["mouza_id"], progress)
            return await asyncio.to_thread(store.ingest, meta, feats)
        except Exception as e:
            await asyncio.to_thread(store.mark_error, meta, e)
            raise


def new_job(kind, label, total):
    jid = next(_job_ids)
    JOBS[jid] = {"id": jid, "kind": kind, "label": label, "total": total, "done": 0, "current": None,
                 "status": "running", "errors": [], "added": 0, "changed": 0, "removed": 0,
                 "started": time.time(), "finished": None}
    # keep the job list short
    for old in sorted(JOBS)[:-30]:
        JOBS.pop(old, None)
    return JOBS[jid]


async def run_mauza_batch(job, metas, run_kind):
    run_id = await asyncio.to_thread(store.start_run, run_kind)
    try:
        for meta in metas:
            if job.get("cancel"):
                job["status"] = "cancelled"
                break
            job["current"] = f'{meta.get("name")} ({meta.get("tehsil")}, {meta.get("district")})'
            try:
                a, c, r = await fetch_mauza(meta)
                job["added"] += a
                job["changed"] += c
                job["removed"] += r
            except Exception as e:
                job["errors"].append(f'{meta.get("name")}: {e}')
                log.warning("mauza %s failed: %s", meta.get("name"), e)
            job["done"] += 1
        if job["status"] == "running":
            job["status"] = "done" if not job["errors"] else "done_with_errors"
    finally:
        job["finished"] = time.time()
        job["current"] = None
        await asyncio.to_thread(store.finish_run, run_id, mauzas=job["done"], added=job["added"],
                                changed=job["changed"], removed=job["removed"], errors=len(job["errors"]),
                                note=job["label"])


# ---------------------------------------------------------------- scheduler
async def refresh_stale(force=False):
    cutoff = time.time() - config.REFRESH_HOURS * 3600
    metas = [m for m in await asyncio.to_thread(store.cached_mauzas)
             if force or (m["last_synced"] or 0) < cutoff]
    if not metas:
        return None
    job = new_job("refresh", f"{'Manual' if force else 'Scheduled'} refresh of {len(metas)} cached mauzas", len(metas))
    SCHED["running"] = True
    try:
        await run_mauza_batch(job, metas, "manual" if force else "scheduled")
    finally:
        SCHED["running"] = False
    return job


async def scheduler_loop():
    await asyncio.sleep(10)
    while True:
        SCHED["last_check"] = time.time()
        try:
            if not SCHED["running"]:
                await refresh_stale()
        except Exception:
            log.exception("scheduled refresh failed")
        SCHED["next_check"] = time.time() + config.SCHEDULER_TICK_MIN * 60
        await asyncio.sleep(config.SCHEDULER_TICK_MIN * 60)


@asynccontextmanager
async def lifespan(app):
    global store, up
    store = Store()
    up = Upstream()
    task = asyncio.create_task(scheduler_loop())
    log.info("Open http://%s:%s in your browser", config.HOST, config.PORT)
    yield
    task.cancel()
    await up.close()


app = FastAPI(title="Punjab Cadastral Explorer", lifespan=lifespan)


def _err(e):
    raise HTTPException(status_code=502, detail=f"Upstream server problem: {e}")


# ---------------------------------------------------------------- hierarchy
@app.get("/api/divisions")
async def divisions():
    return [{"id": i, "name": n, "extent": e} for i, n, e in config.DIVISIONS]


def _ext(s):
    try:
        return [float(x) for x in str(s).split(",")][:4]
    except (TypeError, ValueError):
        return None


@app.get("/api/districts")
async def districts(division_id: int):
    try:
        rows = await up.pulse(f"/Admins/filterDistricts/{division_id}.00000000")
    except UpstreamError as e:
        _err(e)
    out = []
    for r in rows:
        layer = await up.layer_for_district(r["name"])
        out.append({"id": int(float(r["id"])), "name": r["name"], "extent": _ext(r.get("extent")),
                    "layer_id": layer["id"] if layer else None})
    return sorted(out, key=lambda d: d["name"])


@app.get("/api/tehsils")
async def tehsils(district_id: int, layer_id: int):
    try:
        rows = await up.pulse(f"/Admins/filterTehsils/{district_id}")
        out = [{"id": int(float(r["id"])), "name": r["name"], "extent": _ext(r.get("extent"))} for r in rows]
    except UpstreamError:
        out = []
    if not out:
        try:
            out = [dict(t, extent=None) for t in await up.tehsils_from_layer(layer_id)]
        except UpstreamError as e:
            _err(e)
    return sorted(out, key=lambda t: t["name"])


@app.get("/api/mauzas")
async def mauzas(layer_id: int, tehsil_id: int):
    try:
        rows = await up.mauzas(layer_id, tehsil_id)
    except UpstreamError as e:
        # offline: fall back to what is cached
        cached = await asyncio.to_thread(store.mauza_status, layer_id, tehsil_id)
        if not cached:
            _err(e)
        rows = [{"mouza_id": k, "name": v["name"], "count": v["parcel_count"]} for k, v in cached.items()]
    status = await asyncio.to_thread(store.mauza_status, layer_id, tehsil_id)
    for r in rows:
        s = status.get(r["mouza_id"])
        r["cached"] = bool(s and s["last_synced"])
        r["last_synced"] = s["last_synced"] if s else None
        r["cached_count"] = s["parcel_count"] if s else None
        r["status"] = s["last_status"] if s else None
    return rows


# ---------------------------------------------------------------- parcels
def _meta(layer_id, tehsil_id, mouza_id, name, district, tehsil, division):
    return {"layer_id": layer_id, "tehsil_id": tehsil_id, "mouza_id": str(mouza_id), "name": name,
            "district": district, "tehsil": tehsil, "division": division}


@app.get("/api/parcels")
async def parcels(layer_id: int, tehsil_id: int, mouza_id: str, name: str = None, district: str = None,
                  tehsil: str = None, division: str = None, refresh: bool = False):
    """GeoJSON of one mauza. Downloads it first if it is not cached yet (or refresh=1)."""
    m = await asyncio.to_thread(store.get_mauza, layer_id, tehsil_id, mouza_id)
    if refresh or not m or not m["last_synced"]:
        try:
            await fetch_mauza(_meta(layer_id, tehsil_id, mouza_id, name, district, tehsil, division))
        except Exception as e:
            if not (m and m["last_synced"]):
                _err(e)
    gen = store.geojson_chunks(layer_id, tehsil_id, mouza_id)
    return StreamingResponse(gen, media_type="application/geo+json")


@app.get("/api/parcels/tehsil")
async def parcels_tehsil(layer_id: int, tehsil_id: int):
    """GeoJSON of every cached mauza in a tehsil (slim attributes for fast drawing)."""
    return StreamingResponse(store.geojson_chunks(layer_id, tehsil_id, None, slim=True),
                             media_type="application/geo+json")


@app.post("/api/cache/tehsil")
async def cache_tehsil(layer_id: int, tehsil_id: int, district: str = None, tehsil: str = None,
                       division: str = None, only_missing: bool = True):
    """Background job: download every mauza of a tehsil."""
    try:
        rows = await up.mauzas(layer_id, tehsil_id)
    except UpstreamError as e:
        _err(e)
    status = await asyncio.to_thread(store.mauza_status, layer_id, tehsil_id)
    metas = [_meta(layer_id, tehsil_id, r["mouza_id"], r["name"], district, tehsil, division) for r in rows
             if not (only_missing and status.get(r["mouza_id"], {}).get("last_synced"))]
    job = new_job("cache", f"Cache {len(metas)} mauzas of {tehsil} ({district})", len(metas))
    asyncio.create_task(run_mauza_batch(job, metas, "cache"))
    return job


@app.get("/api/jobs")
async def jobs():
    return sorted(JOBS.values(), key=lambda j: -j["id"])


@app.post("/api/jobs/{jid}/cancel")
async def cancel_job(jid: int):
    if jid in JOBS:
        JOBS[jid]["cancel"] = True
    return {"ok": True}


@app.post("/api/sync/run")
async def sync_now():
    if SCHED["running"]:
        raise HTTPException(409, "A refresh is already running")
    asyncio.create_task(refresh_stale(force=True))
    return {"ok": True}


@app.get("/api/sync/status")
async def sync_status():
    cached = await asyncio.to_thread(store.cached_mauzas)
    oldest = min((m["last_synced"] for m in cached), default=None)
    return {"refresh_hours": config.REFRESH_HOURS, "running": SCHED["running"],
            "next_check": SCHED["next_check"], "last_check": SCHED["last_check"],
            "cached_mauzas": len(cached), "oldest_sync": oldest,
            "next_due": (oldest + config.REFRESH_HOURS * 3600) if oldest else None,
            "upstream": up.stats}


@app.get("/api/summary")
async def summary():
    return await asyncio.to_thread(store.summary)


@app.get("/api/changes")
async def changes(limit: int = 200, layer_id: int = None, tehsil_id: int = None, mouza_id: str = None):
    return await asyncio.to_thread(store.changes, limit, layer_id, tehsil_id, mouza_id)


@app.get("/api/search")
async def search(q: str = Query(..., min_length=1), layer_id: int = None, tehsil_id: int = None):
    return await asyncio.to_thread(store.search, q.strip(), layer_id, tehsil_id)


@app.get("/api/export")
async def export(layer_id: int, tehsil_id: int, fmt: str = "geojson", mouza_id: str = None, name: str = "parcels"):
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_") or "parcels"
    if fmt == "geojson":
        return StreamingResponse(store.geojson_chunks(layer_id, tehsil_id, mouza_id),
                                 media_type="application/geo+json",
                                 headers={"Content-Disposition": f'attachment; filename="{base}.geojson"'})
    if fmt == "shp":
        data = await asyncio.to_thread(exporters.to_shapefile_zip, store, layer_id, tehsil_id, mouza_id, base)
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{base}_SHP.zip"'})
    if fmt == "csv":
        data = await asyncio.to_thread(exporters.to_csv, store, layer_id, tehsil_id, mouza_id)
        return Response(data, media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{base}.csv"'})
    raise HTTPException(400, "fmt must be geojson, shp or csv")


# ---------------------------------------------------------------- frontend
app.mount("/static", StaticFiles(directory=str(config.ROOT / "static")), name="static")


@app.get("/")
async def index():
    return FileResponse(config.ROOT / "static" / "index.html")
