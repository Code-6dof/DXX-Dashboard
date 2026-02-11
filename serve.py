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

# Cache the games data in memory
_games_cache = None
_games_cache_mtime = None

def load_games_data():
    """Load games.json and cache it in memory"""
    global _games_cache, _games_cache_mtime
    
    try:
        current_mtime = os.path.getmtime(GAMES_FILE)
        
        # Return cache if file hasn't changed
        if _games_cache is not None and _games_cache_mtime == current_mtime:
            return _games_cache
        
        # Load fresh data
        print(f"Loading games data from {GAMES_FILE}...")
        with open(GAMES_FILE, 'r') as f:
            _games_cache = json.load(f)
        _games_cache_mtime = current_mtime
        print(f"Loaded {len(_games_cache.get('games', []))} games into memory cache")
        return _games_cache
    except Exception as e:
        print(f"Error loading games data: {e}")
        raise

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
        # API endpoint for single game by ID
        elif parsed_path.path.startswith('/api/games/'):
            game_id = parsed_path.path.split('/api/games/')[1]
            self.handle_single_game(game_id)
        else:
            # Regular file serving
            super().do_GET()
    
    def handle_single_game(self, game_id):
        """Return a single game by ID"""
        try:
            data = load_games_data()
            
            games = data.get('games', [])
            
            # Try to find game by ID
            game = None
            for g in games:
                if g.get('id') == game_id:
                    game = g
                    break
            
            # If not found by ID, try matching by old filename-based ID
            if not game and '-' in game_id:
                import re
                ts_match = re.search(r'(\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-\d{2})', game_id)
                if ts_match:
                    for g in games:
                        if g.get('timestamp'):
                            game_ts = g['timestamp'].replace(':', '').replace('T', '-').replace('Z', '')
                            if ts_match.group(1).replace('-', '') in game_ts.replace('-', ''):
                                game = g
                                break
            
            if not game:
                self.send_error(404, f"Game not found: {game_id}")
                return
            
            response = {
                'game': game,
                'players': data.get('players', [])
            }
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            self.send_error(500, f"Error loading game: {str(e)}")
    
    def handle_games_meta(self):
        """Return metadata: total games count, total players, etc."""
        try:
            data = load_games_data()
            
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
            
            data = load_games_data()
            
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
