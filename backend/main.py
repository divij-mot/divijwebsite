# --- START OF FILE main.py ---
"""
Light‑weight signalling server for both the existing Share.tsx P2P file‑sharing
page *and* the new Whiteboard page.

⚙  FastAPI + built‑in WebSocket implementation keeps it tiny enough for Vercel’s
   free tier & easy local testing ( `uvicorn main:app --reload` ).

Endpoints
─────────
GET  /generate-id         →  { id: "<uuid>" }
WS   /ws/{client_id}      →  JSON relay hub; messages include a "target"
                            field (string peer‑ID) or are broadcast.

No other state is stored; once both peers have signalled, all data flows
directly over WebRTC – the server is idle.
"""

from __future__ import annotations

import json
import uuid
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="P2P Signalling Server", version="1.0.0")

#                         ╭────────────────────────────────╮
#                         │             CORS               │
#                         ╰────────────────────────────────╯
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://divijmotwani.com", "http://localhost:5173"],  # tighten this in production!
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In‑memory client registry { client_id: websocket }
clients: Dict[str, WebSocket] = {}


# ──────────────────────────────────────────────────────────────────────────────
#  Helper
# ──────────────────────────────────────────────────────────────────────────────
async def _safe_send(ws: WebSocket, data: str) -> None:
    try:
        await ws.send_text(data)
    except Exception:  # pragma: no cover
        # Ignore failures (client probably gone); let disconnect handler clean up
        pass


# ──────────────────────────────────────────────────────────────────────────────
#  Routes
# ──────────────────────────────────────────────────────────────────────────────
@app.get("/generate-id")
async def generate_id() -> dict:
    """
    Supply a fresh unique ID for a new peer / board.
    """
    return {"id": str(uuid.uuid4())}


@app.get("/healthz")
async def health_check() -> dict:
    """
    Vercel‑friendly health‑check endpoint.
    """
    return {"ok": True}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(ws: WebSocket, client_id: str) -> None:
    """
    Relay JSON messages between peers.  The payloads are **application defined**;
    the only convention this server cares about is the optional `"target"`
    string.  When present the message is forwarded *only* to that peer; otherwise
    it is broadcast to everyone except the sender.

    If a peer disconnects we broadcast a `{"type":"peer-disconnected",
    "peerId":<id>}` message so front‑ends can tidy up.
    """
    # ── Register ─────────────────────────────────────────────────────────────
    await ws.accept()
    if client_id in clients:
        # Should never happen (IDs are UUIDs) but be safe.
        await ws.close(code=4000)
        raise HTTPException(status_code=400, detail="client_id_in_use")

    clients[client_id] = ws
    print(f"[+] {client_id} connected  ({len(clients)} total)")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                payload = json.loads(raw)
            except Exception:  # malformed
                continue

            target_id: str | None = payload.get("target") or payload.get(
                "peerId"
            )
            if target_id and target_id in clients:
                await _safe_send(clients[target_id], raw)
            else:
                # Broadcast to everyone except sender
                for pid, pws in clients.items():
                    if pid != client_id:
                        await _safe_send(pws, raw)
    except WebSocketDisconnect:
        pass
    finally:
        # ── Clean‑up ──────────────────────────────────────────────────────────
        clients.pop(client_id, None)
        msg = json.dumps({"type": "peer-disconnected", "peerId": client_id})
        for pid, pws in list(clients.items()):
            await _safe_send(pws, msg)
        print(f"[-] {client_id} disconnected  ({len(clients)} total)")
# --- END OF FILE main.py ---