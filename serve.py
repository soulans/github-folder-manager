"""Local launcher for GitHub Folder Manager: starts a tiny HTTP server and opens the browser."""
import http.server
import os
import socketserver
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass


def pick_port():
    for port in range(8765, 8775):
        try:
            srv = socketserver.TCPServer(("127.0.0.1", port), Handler)
            return srv, port
        except OSError:
            continue
    raise SystemExit("No free port found between 8765 and 8774")


if __name__ == "__main__":
    server, port = pick_port()
    url = "http://127.0.0.1:%d/index.html" % port
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print("GitHub Folder Manager is running at: " + url)
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
