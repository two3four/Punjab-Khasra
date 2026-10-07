"""Settings. Override any value with an environment variable or a .env-style line in config.env."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file():
    f = ROOT / "config.env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env_file()


def _get(name, default):
    return os.environ.get(name, default)


PULSE_BASE = _get("PULSE_BASE", "https://lis.pulse.gop.pk").rstrip("/")
CADASTRAL_SERVICE = _get(
    "CADASTRAL_SERVICE",
    "https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer",
).rstrip("/")

DB_PATH = Path(_get("DB_PATH", str(ROOT / "data" / "cadastral.db")))
REFRESH_HOURS = float(_get("REFRESH_HOURS", "24"))          # re-check cached mauzas this often
SCHEDULER_TICK_MIN = float(_get("SCHEDULER_TICK_MIN", "15"))  # how often the scheduler wakes up
MAX_CONCURRENCY = int(_get("MAX_CONCURRENCY", "2"))         # parallel requests to the upstream server
REQUEST_DELAY = float(_get("REQUEST_DELAY", "0.4"))         # pause after each upstream request (seconds)
PAGE_SIZE = int(_get("PAGE_SIZE", "2000"))                  # server maxRecordCount is 2000
HOST = _get("HOST", "127.0.0.1")
PORT = int(_get("PORT", "8000"))

USER_AGENT = _get(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
)

# Divisions as listed on lis.pulse.gop.pk (id, name, extent xmin,ymin,xmax,ymax in WGS84)
DIVISIONS = [
    (1, "Bahawalpur", (69.468316822, 27.703041182, 73.974162581, 30.383153413)),
    (2, "Dera Ghazi Khan", (69.33046612, 28.407440247, 71.832969032, 31.395171158)),
    (3, "Faisalabad", (71.617896854, 30.537063185, 73.670740371, 31.993213768)),
    (4, "Gujranwala", (73.775625406, 31.813297434, 75.365623901, 32.843030586)),
    (11, "Gujrat", (73.047317886, 31.756950693, 74.469254201, 33.038330521)),
    (5, "Lahore", (73.262896355, 30.627420793, 74.702264249, 32.068156379)),
    (6, "Multan", (71.019918862, 29.35305958, 72.971588126, 30.740270878)),
    (7, "Rawalpindi", (71.706392048, 32.428694375, 73.798404543, 34.023247124)),
    (8, "Sahiwal", (72.385065605, 30.000724909, 74.134936998, 31.147395767)),
    (9, "Sargodha", (70.82779843, 31.162103104, 73.299354259, 33.228880946)),
]
