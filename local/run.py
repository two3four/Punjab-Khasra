"""Start the Punjab Cadastral Explorer and open it in the browser."""
import threading
import webbrowser

import uvicorn

from app import config

if __name__ == "__main__":
    url = f"http://{'localhost' if config.HOST in ('127.0.0.1', '0.0.0.0') else config.HOST}:{config.PORT}"
    threading.Timer(2.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="info")
