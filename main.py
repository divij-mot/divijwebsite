import time
import uuid
from datetime import datetime, timedelta

from typing import Dict, Any, List

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Divij Website Tools Backend")

# Configure CORS
origins = [
    "http://localhost:5173",  # Allow frontend dev server
    "http://127.0.0.1:5173",
    # Add your production frontend URL here when deployed
    # "https://yourdomain.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dictionary to store connected peers
peers: Dict[str, Dict[str, Any]] = {}

temporary_files: Dict[str, tuple[bytes, Dict[str, Any], datetime]] = {}

def clean_expired_temporary_files():
    """Removes expired temporary files from the dictionary."""
    now = datetime.now()
    expired_files = [
        file_id
        for file_id, (_, _, expiration_time) in temporary_files.items()
        if expiration_time < now
    ]
    for file_id in expired_files:
        del temporary_files[file_id]

def cleanup_task():
    """Periodically cleans expired files."""
    while True:
        clean_expired_temporary_files()
        time.sleep(60)  # Sleep for 1 minute (adjust as needed)

import threading
cleanup_thread = threading.Thread(target=cleanup_task, daemon=True)
cleanup_thread.start()

def register_peer() -> str:
    """Generates a unique peer ID and registers the peer."""
    peer_id = str(uuid.uuid4())
    peers[peer_id] = {"connection_info": "connection info", "signals": []}  # Placeholder for actual connection info
    return peer_id

def get_peer_data(peer_id) -> Dict[str,Any]:
    return peers[peer_id]

def get_all_peers() -> List[str]:
    """Returns a list of all connected peer IDs."""
    return list(peers.keys())

def deregister_peer(peer_id: str) -> None:
    """Deregisters a peer by removing it from the dictionary."""
    if peer_id in peers:
        del peers[peer_id]


@app.post("/api/register-peer")
async def register_peer_endpoint():
    """Registers a new peer and returns a unique ID."""
    peer_id = register_peer()
    return {"peer_id": peer_id}


@app.get("/")
async def read_root():
    """Root endpoint to check if the server is running."""
    return {"message": "Backend server is running"}

@app.get("/api/share")
async def share_endpoint():
    """P2P sharing endpoint."""
    return {"message": "P2P sharing endpoint", "status": "ok"}

@app.post("/api/generate-link")
async def generate_link_endpoint(file_data: bytes, file_metadata: Dict[str, Any]):
    """Generates a temporary shareable link for the given file."""
    response = await upload_temp_file(file_data, file_metadata)
    file_id = response["file_id"]
    link = f"{file_id}"  # Construct the link with the file_id
    return {"link": link}  # Return the link


@app.post("/api/upload-temp-file")
async def upload_temp_file(data: bytes, metadata: Dict[str, Any]):
    """Uploads a file and returns a temporary link."""
    file_id = str(uuid.uuid4())
    expiration_time = datetime.now() + timedelta(hours=1)  # 1-hour expiration
    temporary_files[file_id] = (data, metadata, expiration_time)
    return {"file_id": file_id}

@app.get("/api/get-temp-file")
async def get_temp_file(file_id: str):
    """Returns a temporary file if it exists and has not expired."""
    if file_id in temporary_files:
        file_data, file_metadata, expiration_time = temporary_files[file_id]
        if expiration_time < datetime.now():
            # File has expired
            del temporary_files[file_id]
            return {
                "status": "error",
                "message": f"File with ID {file_id} has expired.",
            }
        return {"status": "ok", "data": file_data, "metadata": file_metadata}
    else:
        return {
            "status": "error", "message": f"File with ID {file_id} not found."
        }
    return {"link": link}


@app.post("/api/signal")
async def signal_endpoint(body: Dict[str, Any]):
    """Signaling endpoint for WebRTC. Routes signals to the specified recipient."""
    recipient_id = body.get("recipient_id")
    sender_id = body.get("sender_id")
    signal_data = {"signal_type": body.get("signal_type"), "data": body.get("data"), "sender_id": sender_id}
    if recipient_id in peers:
        peers[recipient_id]["signals"].append(signal_data)
        return {"status": "ok"}
    else:
        return {"status": "error", "message": f"Recipient with ID {recipient_id} not found."}

@app.get("/api/get_signal")
async def get_signal_endpoint(peer_id: str = Query(..., description="The ID of the peer to get signals for.")):
    """Endpoint to get all signals for a peer."""
    if peer_id in peers:
        signals = peers[peer_id]["signals"]
        peers[peer_id]["signals"] = []  # Clear the signals list after retrieval
        return {"status": "ok", "signals": signals}
    else:
        return {"status": "error", "message": f"Peer with ID {peer_id} not found."}




    
@app.get("/api/get-peers")
async def get_peers_endpoint():
    """Returns a list of all currently connected peers."""
    peer_list = get_all_peers()
    return {"peers": peer_list}

@app.delete("/api/deregister-peer")
async def deregister_peer_endpoint(peer_id: str = Query(..., description="The ID of the peer to deregister.")):
    """Deregisters a peer by removing it from the dictionary."""
    deregister_peer(peer_id)
    return {"message": f"Peer {peer_id} deregistered."}




# --- Placeholder Endpoints for Future Tools ---

# Example: Endpoint for Text Editor (to be implemented)
# @app.post("/api/editor/save")
# async def save_text(content: str):
#     # Logic to save content (e.g., to a file or database)
#     print("Received content:", content[:100] + "...") # Log snippet
#     return {"status": "success", "message": "Content saved (placeholder)"}

# --- Run the server (for local development) ---
if __name__ == "__main__":
    import uvicorn
    # Note: Use `uvicorn backend.main:app --reload` in the terminal for development
    # This __main__ block is mainly for basic execution context or testing
    print("To run the server for development, use: uvicorn backend.main:app --reload --port 8000")