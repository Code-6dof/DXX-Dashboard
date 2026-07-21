"""UDP hole punching for DescentBuddy.

reflexive_address() queries the discovery server's UDP echo port to learn
this machine's public IP and port as seen from outside its NAT router.

punch() fires UDP packets at the peer continuously, which opens a NAT
mapping so the peer's packets can reach us.  Both sides must punch
simultaneously — the 6-second window gives enough overlap even without
perfect clock sync.

Limitation: works for full-cone, address-restricted, and port-restricted
cone NAT (the vast majority of residential routers).  Symmetric NAT
(common on cellular / corporate networks) requires a relay instead.
"""

import socket
import time

_PUNCH_DURATION = 6.0
_PUNCH_INTERVAL = 0.12


def reflexive_address(
    local_port: int,
    server_host: str,
    server_udp_port: int,
) -> tuple[str, int] | None:
    """Return (public_ip, public_port) as seen from outside this NAT.

    Binds to local_port, sends a UDP packet to the echo server, and parses
    the 'ip:port' reply.  Returns None on timeout or bind failure.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", local_port))
    except OSError:
        return None
    sock.settimeout(3.0)
    try:
        sock.sendto(b"stun", (server_host, server_udp_port))
        data, _ = sock.recvfrom(64)
        ip, port_str = data.decode().rsplit(":", 1)
        return ip.strip(), int(port_str)
    except Exception:
        return None
    finally:
        sock.close()


def punch(
    peer_ip: str,
    peer_port: int,
    local_port: int,
    duration: float = _PUNCH_DURATION,
) -> None:
    """Send UDP packets from local_port to peer_ip:peer_port for `duration` s.

    Opens a NAT mapping so the peer's return packets can arrive.  Releases
    the socket when done so DXX can immediately bind to the same local port.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", local_port))
    except OSError:
        sock.bind(("", 0))
    sock.settimeout(0.1)
    deadline = time.time() + duration
    while time.time() < deadline:
        try:
            sock.sendto(b"\x00", (peer_ip, peer_port))
        except Exception:
            pass
        time.sleep(_PUNCH_INTERVAL)
    sock.close()
