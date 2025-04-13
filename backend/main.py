# --- START OF FILE main.py ---

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json
import uuid
import asyncio # Import asyncio for concurrent tasks
from typing import Dict, List, Set, Optional

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Store active connections
class ConnectionManager:
    def __init__(self):
        # Maps user IDs to WebSocket connections
        self.active_connections: Dict[str, WebSocket] = {}
        # Maps user IDs to sets of *currently established* WebRTC peer IDs (less critical here)
        # self.peer_connections: Dict[str, Set[str]] = {} # We don't strictly need to track established peers server-side for basic signaling

    async def connect(self, user_id: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        print(f"User connected: {user_id}, Total users: {len(self.active_connections)}")

    async def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
            print(f"User disconnected: {user_id}, Total users: {len(self.active_connections)}")
            # Notify other users that this user has left (important for cleanup)
            # Create a list of tasks to send disconnect messages concurrently
            tasks = []
            disconnected_message = {"type": "peer-disconnected", "peerId": user_id}
            # Iterate over a copy of the keys, as the dictionary might change
            active_users = list(self.active_connections.keys())
            for other_user_id in active_users:
                 # Check if the other user still exists before sending
                if other_user_id in self.active_connections:
                    tasks.append(self.send_personal_message(disconnected_message, other_user_id))
            if tasks:
                await asyncio.gather(*tasks) # Execute all notifications

    async def send_personal_message(self, message: dict, user_id: str):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_json(message)
            except Exception as e:
                print(f"Error sending message to {user_id}: {e}. Removing broken connection.")
                # Handle potential broken connection state if send fails
                await self.disconnect(user_id) # Trigger cleanup if send fails

    # We don't need broadcast_to_peers if chat messages are sent via WebRTC directly
    # async def broadcast_to_peers(self, message: dict, user_id: str):
    #     pass # Chat messages are now peer-to-peer

manager = ConnectionManager()

@app.get("/")
async def get():
    return {"message": "P2P File Sharing Signaling Server"}

@app.get("/generate-id")
async def generate_id():
    """Generate a unique ID for a new user"""
    return {"id": str(uuid.uuid4())[:8]}

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    # Check if user ID is already in use (optional, but good practice)
    if user_id in manager.active_connections:
        print(f"User ID {user_id} already connected. Closing new connection.")
        await websocket.close(code=1008, reason="User ID already in use")
        return

    await manager.connect(user_id, websocket)

    try:
        # Send confirmation of connection (using the type frontend expects)
        await manager.send_personal_message(
            {"type": "connection-success", "userId": user_id}, # FIX 1: Use 'connection-success'
            user_id
        )

        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            message_type = message.get("type")
            print(f"Received from {user_id}: {message_type}") # Add logging

            # FIX 2: Handle 'request-peer-connection' correctly
            if message_type == "request-peer-connection":
                peer_id_to_connect = message.get("peerId")
                if not peer_id_to_connect:
                    await manager.send_personal_message({"type": "error", "message": "Missing peerId"}, user_id)
                    continue

                print(f"{user_id} requests connection to {peer_id_to_connect}")

                # Check if the target peer is connected
                if peer_id_to_connect in manager.active_connections:
                    print(f"Peer {peer_id_to_connect} found. Notifying both parties.")
                    # Notify the target peer that someone wants to connect, include sender's name and autoAccept flag
                    payload_to_target = {
                        "type": "connection-request",
                        "peerId": user_id,
                        "name": message.get("name", user_id) # Ensure no trailing comma if that was the issue
                    }
                    if message.get("autoAccept"):
                        payload_to_target["autoAccept"] = True
                    await manager.send_personal_message(payload_to_target, peer_id_to_connect)
                    # Removed extra parenthesis from the line below
                    # Notify the requester that the peer was found (they will initiate)
                    # Note: Frontend currently initiates immediately on request,
                    # this 'peer-found' might be slightly redundant with current FE logic,
                    # but good for confirming server found the peer before FE proceeds.
                    # If FE waited for this, it would be cleaner.
                    await manager.send_personal_message(
                        {"type": "peer-found", "peerId": peer_id_to_connect}, # Tell requester peer exists
                        user_id
                    )
                else:
                    print(f"Peer {peer_id_to_connect} not found.")
                    # Notify the requester that the peer was not found
                    await manager.send_personal_message(
                        {"type": "error", "message": f"Peer {peer_id_to_connect} not found or offline."},
                        user_id
                    )

            # This type is not strictly needed if disconnect is handled via WebSocket close
            # elif message_type == "disconnect-from-peer":
            #     peer_id = message.get("peerId")
            #     # Just rely on WebSocket disconnect for cleanup

            elif message_type in ["offer", "answer", "ice-candidate"]:
                # Forward WebRTC signaling messages to the specified peer
                target_peer_id = message.get("target")
                if not target_peer_id:
                     await manager.send_personal_message({"type": "error", "message": "Missing target peerId for signaling message"}, user_id)
                     continue

                if target_peer_id in manager.active_connections:
                    # Include the sender's ID so the recipient knows who it's from
                    message["source"] = user_id
                    print(f"Relaying {message_type} from {user_id} to {target_peer_id}")
                    await manager.send_personal_message(message, target_peer_id)
                else:
                    print(f"Signaling target {target_peer_id} not found for message from {user_id}")
                    # Optionally notify sender that target is gone (though WebRTC might fail anyway)
                    # await manager.send_personal_message(
                    #     {"type": "error", "message": f"Signaling target peer {target_peer_id} is offline."},
                    #     user_id
                    # )

            # Chat messages are now sent directly peer-to-peer via WebRTC data channel
            # elif message_type == "chat-message":
            #     pass # No longer handled by server

            # --- MODIFICATION START: Handle decline ---
            elif message_type == "decline-connection":
                target_peer_id = message.get("target")
                if not target_peer_id:
                    await manager.send_personal_message({"type": "error", "message": "Missing target peerId for decline message"}, user_id)
                    continue

                if target_peer_id in manager.active_connections:
                    print(f"{user_id} declined connection from {target_peer_id}. Notifying {target_peer_id}.")
                    # Notify the original requester that their connection was declined
                    await manager.send_personal_message(
                        {"type": "connection-declined", "source": user_id}, # 'source' is who declined
                        target_peer_id
                    )
                else:
                    print(f"Decline target {target_peer_id} not found for message from {user_id}")
            # --- MODIFICATION END ---

            else:
                print(f"Unknown message type from {user_id}: {message_type}")
                await manager.send_personal_message({"type": "error", "message": f"Unknown message type: {message_type}"}, user_id)

    except WebSocketDisconnect:
        print(f"WebSocket disconnected for user: {user_id}")
    except Exception as e:
        print(f"Error in WebSocket handler for {user_id}: {e}")
    finally:
        # FIX 3: Ensure disconnect cleanup happens and notifies others
        await manager.disconnect(user_id)

if __name__ == "__main__":
    import uvicorn
    # Use "main:app" if running directly, or adjust if using a different file name
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

# --- END OF FILE main.py ---