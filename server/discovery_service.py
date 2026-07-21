"""Network discovery client — endpoint registration, discovery, and punch signaling.

Update _SERVER_URL and _SERVER_HOST after deploying server/discovery_server.py
to the Texas machine.
"""

import requests

_SERVER_URL = "http://dxxtracker.com:8765"
_SERVER_HOST = "dxxtracker.com"              # TODO: dxxtracker.com  (used for UDP echo)
_STUN_PORT = 7654                       # UDP echo port on the discovery server
_TIMEOUT = 5
DEFAULT_PORT = 5197


def get_public_ip() -> "str | None":
    """Fallback public-IP lookup via HTTP (IPv4 forced). Used when UDP echo fails."""
    try:
        return requests.get("https://api4.ipify.org", timeout=_TIMEOUT).text.strip()
    except Exception:
        return None


def register(uid: str, username: str, port: int, status: str = "online") -> bool:
    """Register or heartbeat on the discovery server. Returns True on success."""
    try:
        resp = requests.post(
            f"{_SERVER_URL}/register",
            json={"uid": uid, "username": username, "port": port, "status": status},
            timeout=_TIMEOUT,
        )
        return resp.ok
    except Exception:
        return False


def unregister(uid: str) -> None:
    """Remove this client from the server on clean disconnect."""
    try:
        requests.delete(f"{_SERVER_URL}/unregister/{uid}", timeout=_TIMEOUT)
    except Exception:
        pass


def fetch_players() -> list[dict]:
    """Return all active players from the discovery server."""
    try:
        resp = requests.get(f"{_SERVER_URL}/players", timeout=_TIMEOUT)
        return resp.json() if resp.ok else []
    except Exception:
        return []


def signal_punch(from_uid: str, target_uid: str, from_port: int) -> bool:
    """Tell the server that from_uid wants to connect to target_uid.

    The server stores from_uid's public IP (taken from the HTTP source) and
    from_port so the target host can retrieve them and punch back.
    """
    try:
        resp = requests.post(
            f"{_SERVER_URL}/punch/{target_uid}",
            json={"from_uid": from_uid, "from_port": from_port},
            timeout=_TIMEOUT,
        )
        return resp.ok
    except Exception:
        return False


def poll_punch_inbox(uid: str) -> list[dict]:
    """Return and clear pending punch requests destined for uid.

    Each entry: {from_uid, from_ip, from_port, ts}
    """
    try:
        resp = requests.get(f"{_SERVER_URL}/punch_poll/{uid}", timeout=_TIMEOUT)
        return resp.json() if resp.ok else []
    except Exception:
        return []
