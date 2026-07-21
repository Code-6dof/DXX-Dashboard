"""Descent Buddy network discovery + hole-punch signaling server.

Deploy on the Texas machine:
    pip install fastapi uvicorn
    python discovery_server.py

Exposes:
  HTTP :8765  — player registry + punch signaling
  UDP  :7654  — STUN-lite echo (returns caller's public IP:port)
"""

import socket
import threading
import time
from typing import Dict, List

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

_TTL_SECONDS = 300
_HOST = "0.0.0.0"
_HTTP_PORT = 8765
_UDP_ECHO_PORT = 7654

app = FastAPI(title="Descent Discovery", version="1.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

_players: Dict[str, dict] = {}
_punch_inbox: Dict[str, List] = {}


class RegisterRequest(BaseModel):
    uid: str
    username: str
    port: int
    status: str = "online"


class PunchRequest(BaseModel):
    from_uid: str
    from_port: int = 5197


def _prune() -> None:
    cutoff = time.time() - _TTL_SECONDS
    stale = [uid for uid, p in _players.items() if p["ts"] <= cutoff]
    for uid in stale:
        del _players[uid]


@app.post("/register")
async def register(body: RegisterRequest, request: Request):
    """Register or heartbeat. Server records the caller's public IP automatically."""
    _players[body.uid] = {
        "uid": body.uid,
        "username": body.username,
        "ip": request.client.host,
        "port": body.port,
        "status": body.status,
        "ts": time.time(),
    }
    _prune()
    return {"ok": True}


@app.get("/players")
async def get_players():
    _prune()
    return list(_players.values())


@app.delete("/unregister/{uid}")
async def unregister(uid: str):
    _players.pop(uid, None)
    return {"ok": True}


@app.post("/punch/{target_uid}")
async def request_punch(target_uid: str, body: PunchRequest, request: Request):
    """Guest signals connection intent to a host.
    Server stores the guest's public IP:port so the host can punch back.
    """
    inbox = _punch_inbox.setdefault(target_uid, [])
    inbox.append({
        "from_uid": body.from_uid,
        "from_ip": request.client.host,
        "from_port": body.from_port,
        "ts": time.time(),
    })
    return {"ok": True}


@app.get("/punch_poll/{uid}")
async def punch_poll(uid: str):
    """Return and clear pending punch requests. Drops entries older than 30 s."""
    pending = _punch_inbox.pop(uid, [])
    cutoff = time.time() - 30
    return [r for r in pending if r["ts"] > cutoff]


@app.get("/health")
async def health():
    return {"status": "ok", "players": len(_players)}


def _udp_echo_loop(port: int) -> None:
    """Echo each UDP packet back to the sender as 'ip:port'.
    Clients use this to discover their reflexive (public) address.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("", port))
    while True:
        try:
            _, addr = sock.recvfrom(64)
            sock.sendto(f"{addr[0]}:{addr[1]}".encode(), addr)
        except Exception:
            pass


if __name__ == "__main__":
    threading.Thread(target=_udp_echo_loop, args=(_UDP_ECHO_PORT,), daemon=True).start()
    print(f"UDP echo (STUN-lite) listening on :{_UDP_ECHO_PORT}")
    uvicorn.run(app, host=_HOST, port=_HTTP_PORT)
