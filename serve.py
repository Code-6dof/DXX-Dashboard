#!/usr/bin/env python3
"""
Simple HTTP server with gzip compression for testing.
Compresses JSON responses on the fly.
"""
import http.server
import socketserver
import gzip
import io
from pathlib import Path

PORT = 8080
DIRECTORY = "public"

class GzipRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        # Add compression for JSON files
        if self.path.endswith('.json'):
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
        super().end_headers()
    
    def copyfile(self, source, outputfile):
        if self.path.endswith('.json'):
            # Read the file
            content = source.read()
            # Compress it
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6) as f:
                f.write(content)
            # Send compressed data
            compressed = buf.getvalue()
            outputfile.write(compressed)
            print(f"Compressed {self.path}: {len(content)} → {len(compressed)} bytes ({100 - len(compressed)*100//len(content)}% saved)")
        else:
            super().copyfile(source, outputfile)

if __name__ == '__main__':
    with socketserver.TCPServer(("", PORT), GzipRequestHandler) as httpd:
        print(f"✅ Server running at http://localhost:{PORT}/")
        print(f"📁 Serving directory: {DIRECTORY}")
        print(f"🗜️  Gzip compression enabled for JSON files")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n👋 Server stopped")
