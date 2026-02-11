#!/usr/bin/env python3
"""
Simple HTTP server with CORS and pagination API for serving DXX Dashboard.
"""
import http.server
import socketserver
import signal
import sys
import json
import os
from urllib.parse import urlparse, parse_qs

PORT = 8080
DIRECTORY = "public"
GAMES_FILE = os.path.join(DIRECTORY, "data", "games.json")

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True
    allow_reuse_port = True

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def do_GET(self):
        parsed_path = urlparse(self.path)
        
        # API endpoint for paginated games
        if parsed_path.path == '/api/games':
            self.handle_games_api(parsed_path)
        # API endpoint for game metadata (counts)
        elif parsed_path.path == '/api/games/meta':
            self.handle_games_meta()
        else:
            # Regular file serving
            super().do_GET()
    
    def handle_games_meta(self):
        """Return metadata: total games count, total players, etc."""
        try:
            with open(GAMES_FILE, 'r') as f:
                data = json.load(f)
            
            games = data.get('games', [])
            players = data.get('players', [])
            
            # Calculate stats
            duels = sum(1 for g in games if g.get('players') and len(g['players']) == 2)
            ffa = sum(1 for g in games if g.get('players') and len(g['players']) > 2)
            
            meta = {
                'totalGames': len(games),
                'totalPlayers': len(players),
                'duels': duels,
                'ffa': ffa,
                'oldestGame': games[-1]['timestamp'] if games else None,
                'newestGame': games[0]['timestamp'] if games else None
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(meta).encode())
            
        except Exception as e:
            self.send_error(500, f"Error loading metadata: {str(e)}")
    
    def handle_games_api(self, parsed_path):
        """Return paginated games data"""
        try:
            query = parse_qs(parsed_path.query)
            page = int(query.get('page', ['1'])[0])
            limit = int(query.get('limit', ['100'])[0])
            
            # Limit max page size
            limit = min(limit, 500)
            
            with open(GAMES_FILE, 'r') as f:
                data = json.load(f)
            
            games = data.get('games', [])
            players = data.get('players', [])
            
            # Calculate pagination
            total = len(games)
            start = (page - 1) * limit
            end = start + limit
            
            page_games = games[start:end]
            
            response = {
                'games': page_games,
                'players': players,
                'pagination': {
                    'page': page,
                    'limit': limit,
                    'total': total,
                    'totalPages': (total + limit - 1) // limit,
                    'hasMore': end < total
                }
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_error(500, f"Error loading games: {str(e)}")
    
    def log_message(self, format, *args):
        # Only log API requests
        if '/api/' in self.path:
            sys.stderr.write(f"[API] {format%args}\n")

def shutdown_handler(sig, frame):
    sys.exit(0)

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)
    with ReusableTCPServer(("", PORT), CORSRequestHandler) as httpd:
        print(f" Server running at http://localhost:{PORT}/")
        print(f" Serving directory: {DIRECTORY}")
        print(f" API endpoints: /api/games/meta, /api/games?page=1&limit=100")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n Server stopped")
