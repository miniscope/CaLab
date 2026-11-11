#!/usr/bin/env python3
"""Static server for the labelling page plus the label log.

    python tools/cala-label/serve.py <bundle dir> [--port 8765] [--host 127.0.0.1]

GET /                 the page (index.html next to this file)
GET /items.json       the bundle's order and fixed display ranges
GET /c/<id>/<file>    one candidate's images and trace
GET /api/labels       latest record per candidate, from labels.jsonl
POST /label           append one JSON line to <bundle>/labels.jsonl

Nothing else in the bundle directory is served (manifest.json holds the
provenance and stays private). Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABELS = ("cell", "not", "unsure", None)  # None is an undo
CID = re.compile(r"^[0-9a-f]{8}$")
SERVED = re.compile(r"^/c/([0-9a-f]{8})/([a-z_]+\.(?:png|json))$")
TYPES = {".png": "image/png", ".json": "application/json", ".html": "text/html; charset=utf-8"}

lock = threading.Lock()


def read_latest(path: Path) -> dict:
    """Latest record per cid (the last line wins); torn lines are skipped."""
    latest: dict = {}
    if path.exists():
        for ln in path.read_text().splitlines():
            try:
                rec = json.loads(ln)
                latest[rec["cid"]] = rec
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return latest


def clean_record(raw: dict, known: set[str]) -> dict:
    """Validate one posted label; raise ValueError on anything unexpected."""
    cid = raw.get("cid")
    if not isinstance(cid, str) or not CID.match(cid) or cid not in known:
        raise ValueError("unknown cid")
    label = raw.get("label")
    if label not in LABELS:
        raise ValueError("bad label")
    ms = raw.get("ms", 0)
    return {
        "cid": cid,
        "label": label,
        "merged": bool(raw.get("merged", False)),
        "edge": bool(raw.get("edge", False)),
        "ms": int(ms) if isinstance(ms, (int, float)) else 0,
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "session": str(raw.get("session", ""))[:64],
    }


def make_handler(bundle: Path):
    known = set(json.loads((bundle / "items.json").read_text())["order"])
    log = bundle / "labels.jsonl"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # quiet
            pass

        def send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                return self.send(200, (HERE / "index.html").read_bytes(), TYPES[".html"], {"Cache-Control": "no-store"})
            if path == "/items.json":
                return self.send(200, (bundle / "items.json").read_bytes(), TYPES[".json"], {"Cache-Control": "no-store"})
            if path == "/api/labels":
                return self.send(200, json.dumps(list(read_latest(log).values())).encode(), TYPES[".json"], {"Cache-Control": "no-store"})
            m = SERVED.match(path)
            f = bundle / "c" / m.group(1) / m.group(2) if m else None
            if f and f.is_file():
                return self.send(200, f.read_bytes(), TYPES[f.suffix], {"Cache-Control": "no-store"})
            self.send(404, b"not found", "text/plain")

        def do_POST(self):
            if self.path != "/label":
                return self.send(404, b"not found", "text/plain")
            try:
                n = int(self.headers.get("Content-Length", "0"))
                rec = clean_record(json.loads(self.rfile.read(n)), known)
            except (ValueError, json.JSONDecodeError) as e:
                return self.send(400, str(e).encode(), "text/plain")
            line = (json.dumps(rec, separators=(",", ":")) + "\n").encode()
            with lock, open(log, "ab") as fh:
                fh.write(line)
                fh.flush()
                os.fsync(fh.fileno())
            self.send(200, b"ok", "text/plain")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("bundle")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    bundle = Path(a.bundle).resolve()
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(bundle))
    n = len(json.loads((bundle / "items.json").read_text())["order"])
    done = sum(1 for r in read_latest(bundle / "labels.jsonl").values() if r.get("label"))
    print(f"labelling {n} candidates ({done} already labelled) at http://{a.host}:{a.port}/  -> {bundle / 'labels.jsonl'}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
