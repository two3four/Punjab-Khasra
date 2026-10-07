"""Client for the PULSE admin lookups and the Punjab cadastral ArcGIS MapServer."""
import asyncio
import json
import logging
import re
import time
from difflib import get_close_matches

import httpx

from . import config

log = logging.getLogger("upstream")


class UpstreamError(Exception):
    pass


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


class Upstream:
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(90.0, connect=20.0),
            headers={
                "User-Agent": config.USER_AGENT,
                "Referer": config.PULSE_BASE + "/",
                "Origin": config.PULSE_BASE,
                "Accept": "application/json, text/plain, */*",
            },
            follow_redirects=True,
        )
        self._token = None
        self._token_time = 0.0
        self._token_lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(config.MAX_CONCURRENCY)
        self._layers = None
        self._layers_time = 0.0
        self.stats = {"requests": 0, "errors": 0, "last_ok": None, "last_error": None}

    async def close(self):
        await self.client.aclose()

    # ---------- token ----------
    async def token(self, force=False):
        async with self._token_lock:
            if not force and self._token and time.time() - self._token_time < 20 * 60:
                return self._token
            try:
                r = await self.client.get(config.PULSE_BASE + "/api/gis/token")
                r.raise_for_status()
                data = r.json()
                tok = data.get("token") or data.get("Token")
                if not tok:
                    raise UpstreamError(f"token endpoint returned no token: {str(data)[:200]}")
                self._token, self._token_time = tok, time.time()
                log.info("Fetched new GIS token")
            except Exception as e:  # service may also work without a token
                log.warning("Could not fetch GIS token (%s); continuing without one", e)
                self._token, self._token_time = None, time.time()
            return self._token

    # ---------- generic requests ----------
    async def _get_json(self, url, params=None, use_token=True, retries=4):
        params = dict(params or {})
        last = None
        for attempt in range(retries):
            if use_token:
                tok = await self.token(force=attempt > 0 and last == "token")
                if tok:
                    params["token"] = tok
            try:
                async with self._sem:
                    self.stats["requests"] += 1
                    r = await self.client.get(url, params=params)
                    await asyncio.sleep(config.REQUEST_DELAY)
                if r.status_code in (429, 502, 503, 504):
                    raise UpstreamError(f"HTTP {r.status_code}")
                r.raise_for_status()
                data = r.json()
                if isinstance(data, dict) and data.get("error"):
                    code = data["error"].get("code")
                    if code in (498, 499):
                        last = "token"
                        continue
                    raise UpstreamError(f"ArcGIS error {code}: {data['error'].get('message')}")
                self.stats["last_ok"] = time.time()
                return data
            except (httpx.HTTPError, UpstreamError, json.JSONDecodeError) as e:
                last = str(e)
                self.stats["errors"] += 1
                self.stats["last_error"] = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {e}"
                log.warning("Request failed (%s/%s) %s: %s", attempt + 1, retries, url, e)
                await asyncio.sleep(min(2 ** attempt * 2, 30))
        raise UpstreamError(f"Failed after {retries} attempts: {last}")

    async def pulse(self, path):
        return await self._get_json(config.PULSE_BASE + path, use_token=False)

    async def arcgis(self, path, **params):
        params.setdefault("f", "json")
        return await self._get_json(config.CADASTRAL_SERVICE + path, params)

    # ---------- cadastral service ----------
    async def layers(self):
        if self._layers and time.time() - self._layers_time < 6 * 3600:
            return self._layers
        data = await self.arcgis("")
        self._layers = [{"id": l["id"], "name": l["name"]} for l in data.get("layers", [])
                        if not l.get("subLayerIds")]
        self._layers_time = time.time()
        return self._layers

    async def layer_for_district(self, district_name):
        layers = await self.layers()
        by_norm = {norm(l["name"]): l for l in layers}
        n = norm(district_name)
        if n in by_norm:
            return by_norm[n]
        m = get_close_matches(n, list(by_norm), n=1, cutoff=0.75)
        return by_norm[m[0]] if m else None

    async def tehsils_from_layer(self, layer_id):
        data = await self.arcgis(f"/{layer_id}/query", where="1=1", outFields="Tehsil,Tehsil_ID",
                                 returnDistinctValues="true", returnGeometry="false")
        out = {}
        for f in data.get("features", []):
            a = f["attributes"]
            if a.get("Tehsil_ID") is not None and re.match(r"^[A-Za-z]", a.get("Tehsil") or ""):
                out.setdefault(a["Tehsil_ID"], a["Tehsil"])
        return [{"id": k, "name": v} for k, v in sorted(out.items(), key=lambda kv: kv[1])]

    async def mauzas(self, layer_id, tehsil_id):
        """Mauza list with parcel counts for a tehsil (one grouped statistics request)."""
        try:
            data = await self.arcgis(
                f"/{layer_id}/query", where=f"Tehsil_ID={int(tehsil_id)}",
                groupByFieldsForStatistics="Mouza_ID,Mouza",
                outStatistics=json.dumps([{"statisticType": "count", "onStatisticField": "OBJECTID",
                                           "outStatisticFieldName": "n"}]),
                returnGeometry="false")
            rows = [f["attributes"] for f in data.get("features", [])]
            merged = {}
            for a in rows:
                mid = a.get("Mouza_ID") or a.get("MOUZA_ID")
                if mid is None:
                    continue
                m = merged.setdefault(str(mid), {"mouza_id": str(mid), "name": a.get("Mouza") or a.get("MOUZA"), "count": 0})
                m["count"] += int(a.get("n") or a.get("N") or 0)
            if merged:
                return sorted(merged.values(), key=lambda m: (m["name"] or "").lower())
        except UpstreamError as e:
            log.warning("statistics query failed, falling back to distinct: %s", e)
        data = await self.arcgis(f"/{layer_id}/query", where=f"Tehsil_ID={int(tehsil_id)}",
                                 outFields="Mouza,Mouza_ID", returnDistinctValues="true",
                                 returnGeometry="false", orderByFields="Mouza")
        seen = {}
        for f in data.get("features", []):
            a = f["attributes"]
            if a.get("Mouza_ID") is not None:
                seen.setdefault(str(a["Mouza_ID"]), {"mouza_id": str(a["Mouza_ID"]), "name": a["Mouza"], "count": None})
        return list(seen.values())

    async def mauza_features(self, layer_id, tehsil_id, mouza_id, progress=None):
        """All parcels of one mauza as GeoJSON features (WGS84), paged by OBJECTID."""
        where = f"Tehsil_ID={int(tehsil_id)} AND Mouza_ID='{str(mouza_id).replace(chr(39), '')}'"
        cnt = await self.arcgis(f"/{layer_id}/query", where=where, returnCountOnly="true")
        total = int(cnt.get("count", 0))
        feats, offset = [], 0
        while offset < total:
            data = await self.arcgis(
                f"/{layer_id}/query", where=where, outFields="*", returnGeometry="true",
                outSR="4326", geometryPrecision="7", orderByFields="OBJECTID",
                resultOffset=str(offset), resultRecordCount=str(config.PAGE_SIZE), f="geojson")
            page = data.get("features", [])
            if not page:
                break
            feats.extend(page)
            offset += len(page)
            if progress:
                progress(offset, total)
        if len(feats) < total:
            raise UpstreamError(f"Incomplete download: got {len(feats)} of {total}")
        return feats
