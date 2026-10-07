"""SQLite cache of parcels, mauza sync status and change history."""
import hashlib
import json
import math
import sqlite3
import threading
import time

from . import config

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS mauza (
    layer_id INTEGER, tehsil_id INTEGER, mouza_id TEXT,
    name TEXT, district TEXT, tehsil TEXT, division TEXT,
    parcel_count INTEGER DEFAULT 0, area_m2 REAL DEFAULT 0,
    bbox TEXT, last_synced REAL, last_status TEXT, last_error TEXT,
    added INTEGER DEFAULT 0, changed INTEGER DEFAULT 0, removed INTEGER DEFAULT 0,
    first_cached REAL,
    PRIMARY KEY (layer_id, tehsil_id, mouza_id)
);
CREATE TABLE IF NOT EXISTS parcel (
    layer_id INTEGER, tehsil_id INTEGER, mouza_id TEXT, pkey TEXT,
    objectid INTEGER, label TEXT, khasra_id INTEGER, khewat_id INTEGER,
    area_m2 REAL, cx REAL, cy REAL,
    props TEXT, geom TEXT, hash TEXT, first_seen REAL, last_changed REAL,
    PRIMARY KEY (layer_id, tehsil_id, mouza_id, pkey)
);
CREATE INDEX IF NOT EXISTS ix_parcel_label ON parcel(label);
CREATE INDEX IF NOT EXISTS ix_parcel_tehsil ON parcel(layer_id, tehsil_id);
CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, layer_id INTEGER, tehsil_id INTEGER,
    mouza_id TEXT, mauza TEXT, district TEXT, tehsil TEXT, pkey TEXT, label TEXT, kind TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_change_ts ON change_log(ts);
CREATE TABLE IF NOT EXISTS sync_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started REAL, finished REAL, kind TEXT,
    mauzas INTEGER DEFAULT 0, added INTEGER DEFAULT 0, changed INTEGER DEFAULT 0,
    removed INTEGER DEFAULT 0, errors INTEGER DEFAULT 0, note TEXT
);
"""

# Punjab land units: 1 marla = 272.25 sq ft, 20 marla = 1 kanal, 8 kanal = 1 acre
MARLA_M2 = 272.25 * 0.09290304
KANAL_M2 = MARLA_M2 * 20
ACRE_M2 = KANAL_M2 * 8


def ring_area(coords):
    """Geodesic area (m2) of a lon/lat ring, spherical approximation (same as Turf.js)."""
    r = 6378137.0
    n = len(coords)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        lo, mi, hi = coords[i], coords[(i + 1) % n], coords[(i + 2) % n]
        total += (math.radians(hi[0]) - math.radians(lo[0])) * math.sin(math.radians(mi[1]))
    return abs(total * r * r / 2.0)


def geom_area(g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    a = 0.0
    for p in polys:
        if p:
            a += ring_area(p[0]) - sum(ring_area(h) for h in p[1:])
    return a


def geom_bbox_centroid(g):
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    xs, ys = [], []
    for p in polys:
        for x, y in p[0]:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None, None, None
    return (min(xs), min(ys), max(xs), max(ys)), (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def fmt_area(m2):
    if m2 is None:
        return ""
    kanal = int(m2 // KANAL_M2)
    marla = (m2 - kanal * KANAL_M2) / MARLA_M2
    return f"{kanal}K-{marla:.1f}M"


VOLATILE = {"OBJECTID", "Shape.STArea()", "Shape.STLength()"}


class Store:
    def __init__(self, path=None):
        self.path = path or config.DB_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.conn().executescript(SCHEMA)

    def conn(self):
        c = getattr(self._local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=60)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA synchronous=NORMAL")
            self._local.c = c
        return c

    # ---------- mauza ----------
    def mauza_status(self, layer_id, tehsil_id):
        rows = self.conn().execute(
            "SELECT * FROM mauza WHERE layer_id=? AND tehsil_id=?", (layer_id, tehsil_id)).fetchall()
        return {r["mouza_id"]: dict(r) for r in rows}

    def get_mauza(self, layer_id, tehsil_id, mouza_id):
        r = self.conn().execute("SELECT * FROM mauza WHERE layer_id=? AND tehsil_id=? AND mouza_id=?",
                                (layer_id, tehsil_id, str(mouza_id))).fetchone()
        return dict(r) if r else None

    def cached_mauzas(self):
        return [dict(r) for r in self.conn().execute(
            "SELECT * FROM mauza WHERE last_synced IS NOT NULL ORDER BY last_synced").fetchall()]

    def mark_error(self, meta, err):
        c = self.conn()
        c.execute("""INSERT INTO mauza(layer_id,tehsil_id,mouza_id,name,district,tehsil,division,last_status,last_error)
                     VALUES(?,?,?,?,?,?,?,'error',?)
                     ON CONFLICT(layer_id,tehsil_id,mouza_id) DO UPDATE SET last_status='error', last_error=excluded.last_error""",
                  (meta["layer_id"], meta["tehsil_id"], str(meta["mouza_id"]), meta.get("name"),
                   meta.get("district"), meta.get("tehsil"), meta.get("division"), str(err)[:500]))
        c.commit()

    # ---------- ingest with change detection ----------
    def ingest(self, meta, features):
        """Replace a mauza's parcels with a fresh download; returns (added, changed, removed)."""
        L, T, M = meta["layer_id"], meta["tehsil_id"], str(meta["mouza_id"])
        now = time.time()
        c = self.conn()
        existing = {r["pkey"]: (r["hash"], r["label"]) for r in c.execute(
            "SELECT pkey, hash, label FROM parcel WHERE layer_id=? AND tehsil_id=? AND mouza_id=?", (L, T, M))}
        first_load = self.get_mauza(L, T, M) is None or not existing
        seen, rows, logs = set(), [], []
        added = changed = 0
        total_area = 0.0
        bx = [180, 90, -180, -90]
        for f in features:
            p = f.get("properties") or {}
            g = f.get("geometry")
            if not g:
                continue
            oid = p.get("OBJECTID") or f.get("id")
            pkey = str(p["Khasra_ID"]) if p.get("Khasra_ID") not in (None, 0) else f"oid:{oid}"
            if pkey in seen:
                pkey = f"{pkey}:{oid}"
            seen.add(pkey)
            gjson = json.dumps(g, separators=(",", ":"))
            stable = {k: v for k, v in p.items() if k not in VOLATILE}
            h = hashlib.sha1((json.dumps(stable, sort_keys=True) + gjson).encode()).hexdigest()
            area = geom_area(g)
            total_area += area
            bb, cx, cy = geom_bbox_centroid(g)
            if bb:
                bx = [min(bx[0], bb[0]), min(bx[1], bb[1]), max(bx[2], bb[2]), max(bx[3], bb[3])]
            label = p.get("Label") or p.get("Join_Shp")
            old = existing.get(pkey)
            if old is None:
                added += 1
                if not first_load:
                    logs.append((pkey, label, "added", None))
            elif old[0] != h:
                changed += 1
                logs.append((pkey, label, "changed", None))
            rows.append((L, T, M, pkey, oid, label, p.get("Khasra_ID"), p.get("Khewat_ID"), area, cx, cy,
                         json.dumps(p, separators=(",", ":"), ensure_ascii=False), gjson, h,
                         now if old is None else None, now if (old is None or old[0] != h) else None))
        removed_keys = [k for k in existing if k not in seen]
        for k in removed_keys:
            logs.append((k, existing[k][1], "removed", None))

        with c:
            for i in range(0, len(removed_keys), 500):
                chunk = removed_keys[i:i + 500]
                c.execute("DELETE FROM parcel WHERE layer_id=? AND tehsil_id=? AND mouza_id=? AND pkey IN (%s)" %
                          ",".join("?" * len(chunk)), (L, T, M, *chunk))
            c.executemany("""
                INSERT INTO parcel(layer_id,tehsil_id,mouza_id,pkey,objectid,label,khasra_id,khewat_id,area_m2,cx,cy,
                                   props,geom,hash,first_seen,last_changed)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,strftime('%s','now')),COALESCE(?,strftime('%s','now')))
                ON CONFLICT(layer_id,tehsil_id,mouza_id,pkey) DO UPDATE SET
                    objectid=excluded.objectid, label=excluded.label, khasra_id=excluded.khasra_id,
                    khewat_id=excluded.khewat_id, area_m2=excluded.area_m2, cx=excluded.cx, cy=excluded.cy,
                    props=excluded.props, geom=excluded.geom,
                    last_changed=CASE WHEN parcel.hash<>excluded.hash THEN excluded.last_changed ELSE parcel.last_changed END,
                    hash=excluded.hash
            """, rows)
            c.executemany("""INSERT INTO change_log(ts,layer_id,tehsil_id,mouza_id,mauza,district,tehsil,pkey,label,kind,detail)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                          [(now, L, T, M, meta.get("name"), meta.get("district"), meta.get("tehsil"), k, lab, kind, d)
                           for k, lab, kind, d in logs])
            c.execute("""
                INSERT INTO mauza(layer_id,tehsil_id,mouza_id,name,district,tehsil,division,parcel_count,area_m2,bbox,
                                  last_synced,last_status,last_error,added,changed,removed,first_cached)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,'ok',NULL,?,?,?,?)
                ON CONFLICT(layer_id,tehsil_id,mouza_id) DO UPDATE SET
                    name=COALESCE(excluded.name,mauza.name), district=COALESCE(excluded.district,mauza.district),
                    tehsil=COALESCE(excluded.tehsil,mauza.tehsil), division=COALESCE(excluded.division,mauza.division),
                    parcel_count=excluded.parcel_count, area_m2=excluded.area_m2, bbox=excluded.bbox,
                    last_synced=excluded.last_synced, last_status='ok', last_error=NULL,
                    added=excluded.added, changed=excluded.changed, removed=excluded.removed,
                    first_cached=COALESCE(mauza.first_cached, excluded.first_cached)
            """, (L, T, M, meta.get("name"), meta.get("district"), meta.get("tehsil"), meta.get("division"),
                  len(rows), total_area, json.dumps(bx) if rows else None, now,
                  0 if first_load else added, changed, len(removed_keys), now))
        return (0 if first_load else added), changed, len(removed_keys)

    # ---------- reads ----------
    def features_sql(self, layer_id, tehsil_id, mouza_id=None, conn=None):
        q = "SELECT * FROM parcel WHERE layer_id=? AND tehsil_id=?"
        args = [layer_id, tehsil_id]
        if mouza_id is not None:
            q += " AND mouza_id=?"
            args.append(str(mouza_id))
        return (conn or self.conn()).execute(q + " ORDER BY mouza_id, objectid", args)

    def stream_conn(self):
        """Separate connection for streaming responses (iterated across worker threads)."""
        c = sqlite3.connect(self.path, timeout=60, check_same_thread=False)
        c.row_factory = sqlite3.Row
        return c

    def geojson_chunks(self, layer_id, tehsil_id, mouza_id=None, slim=False):
        conn = self.stream_conn()
        try:
            yield from self._geojson(conn, layer_id, tehsil_id, mouza_id, slim)
        finally:
            conn.close()

    def _geojson(self, conn, layer_id, tehsil_id, mouza_id, slim):
        yield '{"type":"FeatureCollection","features":['
        first = True
        for r in self.features_sql(layer_id, tehsil_id, mouza_id, conn=conn):
            props = json.loads(r["props"])
            if slim:
                props = {k: props.get(k) for k in ("Label", "Mouza", "Khasra_ID", "Khewat_ID", "MN", "K", "Type")}
            props["area_m2"] = round(r["area_m2"] or 0, 2)
            props["area_KM"] = fmt_area(r["area_m2"])
            props["_mouza_id"] = r["mouza_id"]
            props["_pkey"] = r["pkey"]
            s = '{"type":"Feature","id":%s,"properties":%s,"geometry":%s}' % (
                json.dumps(r["objectid"]), json.dumps(props, ensure_ascii=False, separators=(",", ":")), r["geom"])
            yield s if first else "," + s
            first = False
        yield "]}"

    def search(self, q, layer_id=None, tehsil_id=None, limit=50):
        sql = """SELECT p.layer_id,p.tehsil_id,p.mouza_id,p.pkey,p.label,p.khasra_id,p.khewat_id,p.area_m2,p.cx,p.cy,
                        m.name AS mauza, m.district, m.tehsil
                 FROM parcel p LEFT JOIN mauza m USING(layer_id,tehsil_id,mouza_id)
                 WHERE (p.label = ? OR p.label LIKE ? OR CAST(p.khasra_id AS TEXT)=? OR CAST(p.khewat_id AS TEXT)=?)"""
        args = [q, q + "%", q, q]
        if layer_id is not None:
            sql += " AND p.layer_id=?"
            args.append(layer_id)
        if tehsil_id is not None:
            sql += " AND p.tehsil_id=?"
            args.append(tehsil_id)
        rows = self.conn().execute(sql + " LIMIT ?", (*args, limit)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["area_KM"] = fmt_area(d["area_m2"])
            out.append(d)
        return out

    def changes(self, limit=200, layer_id=None, tehsil_id=None, mouza_id=None):
        sql, args = "SELECT * FROM change_log WHERE 1=1", []
        for col, v in (("layer_id", layer_id), ("tehsil_id", tehsil_id), ("mouza_id", mouza_id)):
            if v is not None:
                sql += f" AND {col}=?"
                args.append(v)
        return [dict(r) for r in self.conn().execute(sql + " ORDER BY id DESC LIMIT ?", (*args, limit))]

    def summary(self):
        c = self.conn()
        tot = dict(c.execute("""SELECT COUNT(*) AS mauzas, COALESCE(SUM(parcel_count),0) AS parcels,
                                COALESCE(SUM(area_m2),0) AS area_m2, MAX(last_synced) AS last_synced,
                                SUM(CASE WHEN last_status='error' THEN 1 ELSE 0 END) AS errors
                                FROM mauza WHERE last_synced IS NOT NULL OR last_status='error'""").fetchone())
        by_tehsil = [dict(r) for r in c.execute("""
            SELECT division, district, tehsil, layer_id, tehsil_id, COUNT(*) AS mauzas, SUM(parcel_count) AS parcels,
                   SUM(area_m2) AS area_m2, MIN(last_synced) AS oldest_sync, MAX(last_synced) AS newest_sync
            FROM mauza WHERE last_synced IS NOT NULL GROUP BY layer_id, tehsil_id ORDER BY district, tehsil""")]
        since = time.time() - 7 * 86400
        week = [dict(r) for r in c.execute("""
            SELECT date(ts,'unixepoch','localtime') AS day, kind, COUNT(*) AS n FROM change_log
            WHERE ts>=? GROUP BY day, kind ORDER BY day""", (since,))]
        runs = [dict(r) for r in c.execute("SELECT * FROM sync_run ORDER BY id DESC LIMIT 10")]
        return {"totals": tot, "by_tehsil": by_tehsil, "changes_7d": week, "runs": runs}

    # ---------- sync runs ----------
    def start_run(self, kind):
        c = self.conn()
        cur = c.execute("INSERT INTO sync_run(started, kind) VALUES(?,?)", (time.time(), kind))
        c.commit()
        return cur.lastrowid

    def finish_run(self, run_id, **kw):
        c = self.conn()
        c.execute("""UPDATE sync_run SET finished=?, mauzas=?, added=?, changed=?, removed=?, errors=?, note=?
                     WHERE id=?""", (time.time(), kw.get("mauzas", 0), kw.get("added", 0), kw.get("changed", 0),
                                     kw.get("removed", 0), kw.get("errors", 0), kw.get("note"), run_id))
        c.commit()
