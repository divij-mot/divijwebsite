from __future__ import annotations

import json
import uuid
import asyncio
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.websockets import WebSocketState


import os
allowed_origins_str = os.getenv("ALLOWED_ORIGINS", "https://divijmotwani.com,http://localhost:5173")
ALLOWED_ORIGINS = [origin.strip() for origin in allowed_origins_str.split(',')]

app = FastAPI(title="P2P Signalling Server (Combined)", version="1.1.0")

@app.get("/health")
@app.head("/health")
async def health():
    return {"status": "ok"}


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, client_id: str, websocket: WebSocket):
        await websocket.accept()
        if client_id in self.active_connections:
            print(f"WARN: Client ID {client_id} already connected. Closing new connection.")
            await websocket.close(code=4001, reason="Client ID already connected")
            raise WebSocketDisconnect(code=4001, reason="Client ID already connected") 
        self.active_connections[client_id] = websocket
        print(f"[+] {client_id} connected ({len(self.active_connections)} total)")

    async def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            ws_to_close = self.active_connections.pop(client_id, None)
            print(f"[-] {client_id} disconnected ({len(self.active_connections)} total)")

            disconnected_message = {"type": "peer-disconnected", "peerId": client_id}
            await self.broadcast(disconnected_message, exclude_client_id=None) 

            if ws_to_close and ws_to_close.client_state != WebSocketState.DISCONNECTED:
                 try:
                     await ws_to_close.close()
                 except RuntimeError: 
                     pass


    async def send_personal_message(self, message: dict, client_id: str):
        websocket = self.active_connections.get(client_id)
        if websocket:
            try:
                await websocket.send_json(message)
            except (WebSocketDisconnect, RuntimeError) as e: 
                print(f"Error sending message to {client_id} (likely disconnected): {e}. Cleaning up.")
                await self.disconnect(client_id) 
            except Exception as e:
                print(f"Unexpected error sending message to {client_id}: {e}")
                await self.disconnect(client_id)


    async def broadcast(self, message: dict, exclude_client_id: str | None):
        message_json = json.dumps(message) 
        tasks = []
        for client_id, websocket in list(self.active_connections.items()):
            if client_id != exclude_client_id:
                 tasks.append(self._safe_send_text(websocket, message_json, client_id)) 
        if tasks:
            await asyncio.gather(*tasks)

    async def _safe_send_text(self, ws: WebSocket, data: str, client_id_for_log: str):
        """Helper to send text and handle potential disconnects during broadcast."""
        try:
            await ws.send_text(data)
        except (WebSocketDisconnect, RuntimeError) as e:
            print(f"Error during broadcast to {client_id_for_log} (likely disconnected): {e}. Cleaning up.")
            await self.disconnect(client_id_for_log) 
        except Exception as e:
             print(f"Unexpected error during broadcast to {client_id_for_log}: {e}")
             await self.disconnect(client_id_for_log)


manager = ConnectionManager()

@app.get("/generate-id")
async def generate_id_route() -> dict:
    """Generate a unique ID for a new client."""
    return {"id": str(uuid.uuid4())}

@app.get("/healthz")
async def health_check() -> dict:
    """Basic health check endpoint."""
    return {"ok": True, "connected_clients": len(manager.active_connections)}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """Handles WebSocket connections and message relaying for WebRTC signaling."""
    try:
        await manager.connect(client_id, websocket)
        await manager.send_personal_message({"type": "connection-success", "userId": client_id}, client_id)
    except WebSocketDisconnect as e:
        print(f"Connection refused or failed for {client_id}: {e.reason}")
        return 

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                message = json.loads(raw_data)
            except json.JSONDecodeError:
                print(f"Received invalid JSON from {client_id}. Ignoring.")
                continue 

            message_type = message.get("type")
            target_id = message.get("target") or message.get("peerId") 

            print(f"MSG RCVD from {client_id}: type={message_type}, target={target_id}")

            if message_type == "request-peer-connection" or message_type == "connection-request": 
                peer_id_to_connect = message.get("peerId") or message.get("target") 
                if not peer_id_to_connect:
                    await manager.send_personal_message({"type": "error", "message": "Missing target peerId for connection request"}, client_id)
                    continue

                print(f"{client_id} requests connection to {peer_id_to_connect}")
                target_ws = manager.active_connections.get(peer_id_to_connect)

                if target_ws:
                    payload_to_target = {
                        "type": "connection-request", 
                        "peerId": client_id, 
                        "source": client_id, 
                        "name": message.get("name", client_id), 
                    }
                    if message.get("autoAccept"):
                        payload_to_target["autoAccept"] = True

                    print(f"  -> Forwarding connection request to {peer_id_to_connect}")
                    await manager.send_personal_message(payload_to_target, peer_id_to_connect)

                    print(f"  -> Notifying {client_id} that peer {peer_id_to_connect} was found")
                    await manager.send_personal_message({"type": "peer-found", "peerId": peer_id_to_connect}, client_id)
                else:
                    print(f"  -> Target peer {peer_id_to_connect} not found.")
                    await manager.send_personal_message(
                        {"type": "error", "message": f"Peer {peer_id_to_connect} not found or offline."},
                        client_id
                    )

            elif message_type in ["offer", "answer", "ice-candidate"]:
                if not target_id:
                    print(f"WARN: Missing target for {message_type} from {client_id}")
                    await manager.send_personal_message({"type": "error", "message": f"Missing target for {message_type}"}, client_id)
                    continue

                target_ws = manager.active_connections.get(target_id)
                if target_ws:
                    try:
                        parsed_message = json.loads(raw_data)
                        parsed_message["source"] = client_id 
                        modified_json_data = json.dumps(parsed_message)
                        print(f"  -> Relaying {message_type} from {client_id} to {target_id} with source added")
                        await manager._safe_send_text(target_ws, modified_json_data, target_id) 
                    except json.JSONDecodeError:
                         print(f"ERROR: Could not parse JSON for relay from {client_id}. Raw: {raw_data}")
                    except Exception as e:
                         print(f"ERROR: Failed to relay message from {client_id} to {target_id}: {e}")

                else:
                    print(f"  -> Target {target_id} for {message_type} from {client_id} not found.")

            elif message_type == "decline-connection" or message_type == "connection-declined": 
                 target_requester_id = message.get("target") 
                 if not target_requester_id:
                     await manager.send_personal_message({"type": "error", "message": "Missing target for decline message"}, client_id)
                     continue

                 target_ws = manager.active_connections.get(target_requester_id)
                 if target_ws:
                     print(f"  -> {client_id} declined connection from {target_requester_id}. Notifying requester.")
                     await manager.send_personal_message(
                         {"type": "connection-declined", "peerId": client_id, "source": client_id}, 
                         target_requester_id
                     )
                 else:
                     print(f"  -> Decline target {target_requester_id} not found.")

            elif message_type == "connection-success": 
                 target_initiator_id = message.get("target") 
                 if not target_initiator_id:
                     await manager.send_personal_message({"type": "error", "message": "Missing target for connection-success"}, client_id)
                     continue

                 target_ws = manager.active_connections.get(target_initiator_id)
                 if target_ws:
                     print(f"  -> {client_id} accepted connection from {target_initiator_id}. Notifying initiator.")
                     await manager.send_personal_message(
                         {"type": "connection-success", "peerId": client_id, "source": client_id}, 
                         target_initiator_id
                     )
                 else:
                     print(f"  -> Connection-success target {target_initiator_id} not found.")


            elif target_id:
                 target_ws = manager.active_connections.get(target_id)
                 if target_ws:
                     if "source" not in message: message["source"] = client_id
                     print(f"  -> Relaying generic message from {client_id} to {target_id}")
                     await manager._safe_send_text(target_ws, json.dumps(message), target_id) 
                 else:
                     print(f"  -> Target {target_id} for generic message from {client_id} not found.")


            else:
                print(f"WARN: Unknown or unhandled message type '{message_type}' from {client_id}")

    except WebSocketDisconnect:
        print(f"WebSocket disconnected for {client_id} (client closed)")
    except Exception as e:
        import traceback
        print(f"!!! UNEXPECTED ERROR in WebSocket handler for {client_id}: {e}")
        traceback.print_exc() 
    finally:
        print(f"Cleaning up connection for {client_id}")
        await manager.disconnect(client_id)


if __name__ == "__main__":
    import uvicorn
    print(f"Starting server with allowed origins: {ALLOWED_ORIGINS}")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)