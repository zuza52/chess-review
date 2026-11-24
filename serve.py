#!/usr/bin/env python3
"""Р›РѕРєР°Р»СЊРЅС‹Р№ СЃРµСЂРІРµСЂ РґР»СЏ Chess Review.

РќСѓР¶РµРЅ РїРѕС‚РѕРјСѓ, С‡С‚Рѕ Web Worker + WASM + Service Worker РЅРµ СЂР°Р±РѕС‚Р°СЋС‚ СЃ file://.
Р—Р°РїСѓСЃРє:  python serve.py [РїРѕСЂС‚]
"""
import http.server
import os
import socket
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090

MIME = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".pgn": "text/plain; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args) or "500" in (fmt % args):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    try:
        httpd = Server(("0.0.0.0", PORT), Handler)
    except OSError as exc:
        print(f"РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РЅСЏС‚СЊ РїРѕСЂС‚ {PORT}: {exc}")
        print(f"РџРѕРїСЂРѕР±СѓР№С‚Рµ: python serve.py {PORT + 1}")
        return 1

    print()
    print("  Chess Review Р·Р°РїСѓС‰РµРЅ")
    print(f"  РљРѕРјРїСЊСЋС‚РµСЂ:  http://localhost:{PORT}")
    print(f"  РўРµР»РµС„РѕРЅ:    http://{lan_ip()}:{PORT}   (С‚Р° Р¶Рµ Wi-Fi СЃРµС‚СЊ)")
    print()
    print("  РћСЃС‚Р°РЅРѕРІРёС‚СЊ: Ctrl+C")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nРЎРµСЂРІРµСЂ РѕСЃС‚Р°РЅРѕРІР»РµРЅ.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
