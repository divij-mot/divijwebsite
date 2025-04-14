// --- START OF FILE Share.tsx ---

// @/src/pages/Share.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer from 'simple-peer/simplepeer.min.js'; // Explicitly import browser bundle
import type { Instance as PeerInstance } from 'simple-peer'; // Import type separately
import { Upload, Download, Copy, Link as LinkIcon, Users, MessageSquare, X, Check, RefreshCw, Send, Paperclip, AlertCircle, WifiOff, Wifi, Loader2 } from 'lucide-react';

// Constants (ensure these are correct for your setup)
const SIGNALING_SERVER_URL = process.env.NODE_ENV === 'development' ? 'ws://localhost:8000' : 'wss://your-production-ws-domain.com'; // <-- REPLACE if needed
const API_BASE_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : 'https://your-production-api-domain.com'; // <-- REPLACE if needed
const FILE_CHUNK_SIZE = 64 * 1024; // 64KB chunks

// Types
interface PeerConnection {
  peerId: string;
  peer: PeerInstance;
  status: 'connecting' | 'connected' | 'failed' | 'disconnected' | 'pending_approval'; // Add pending_approval
  isInitiator: boolean;
  name?: string; // Add optional name field
  offerData?: any; // Add field to store offer for pending connections
}
// Add state for incoming requests (will use this later for Decline feature)
interface IncomingRequest {
    peerId: string;
    offerData?: any; // Store initial offer if needed
}
interface ChatMessage { id: string; text: string; sender: string; senderName?: string; timestamp: number; } // Add senderName
interface ReceivedFile { id: string; name: string; size: number; blob: Blob; from: string; fromName?: string; timestamp: number; }
interface FileTransferProgress {
  [key: string]: {
    progress: number;
    status: 'sending' | 'receiving' | 'complete' | 'failed';
    fileName?: string;
    fileSize?: number;
  };
}

// Helpers
const generateLocalId = () => Math.random().toString(36).substring(2, 15);
const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};


const Share: React.FC = () => {
  // --- State ---
  const [userId, setUserId] = useState<string>('');
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [userName, setUserName] = useState<string>('');
  const [isNameSet, setIsNameSet] = useState<boolean>(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [peerConnections, setPeerConnections] = useState<Record<string, PeerConnection>>({});
  const [peerIdInput, setPeerIdInput] = useState<string>('');
  const [isConnectingPeer, setIsConnectingPeer] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [sendProgress, setSendProgress] = useState<FileTransferProgress>({});
  const [receiveProgress, setReceiveProgress] = useState<FileTransferProgress>({});
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]); // Definition updated below
  const [incomingRequests, setIncomingRequests] = useState<Record<string, IncomingRequest>>({});
  const [messageInput, setMessageInput] = useState<string>('');
  const [showChat, setShowChat] = useState<boolean>(true);
  const [shareLink, setShareLink] = useState<string>('');
  const [linkCopied, setLinkCopied] = useState<boolean>(false);

  // --- Refs ---
  const socketRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const fileChunksRef = useRef<Record<string, any>>({});
  const peerConnectionsRef = useRef(peerConnections);
  // Refs to hold latest state values for use in callbacks without causing dependency loops
  const userIdRef = useRef(userId);
  const userNameRef = useRef(userName);
  const isConnectingPeerRef = useRef(isConnectingPeer);

  // Update refs whenever state changes
  useEffect(() => {
    peerConnectionsRef.current = peerConnections;
  }, [peerConnections]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);
  useEffect(() => {
    isConnectingPeerRef.current = isConnectingPeer;
  }, [isConnectingPeer]);


  // --- Stable add chat message function ---
  const addChatMessage = useCallback((text: string, sender: string) => {
    const senderName = sender === 'me' ? userNameRef.current : peerConnectionsRef.current[sender]?.name ?? sender;
    const newMessage: ChatMessage = { // Updated ChatMessage definition needed below
      id: generateLocalId(), text, sender, senderName, timestamp: Date.now()
    };
    setChatMessages(prev => [...prev, newMessage]);
  }, []); // Depends on refs, stable


  // --- WebSocket Message Sending ---
  const sendMessageToServer = useCallback((message: object) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      try {
        // console.log("Sending message to server:", message);
        socketRef.current.send(JSON.stringify(message));
      } catch (error) {
        console.error("Failed to send message via WebSocket:", error);
        setServerError("Failed to communicate with server.");
      }
    } else {
      console.error('Cannot send message: WebSocket not connected.');
      setServerError('Not connected to server. Please wait or refresh.');
    }
  }, []); // No dependencies, relies on socketRef


  // --- Peer Connection Management ---

   // Stable disconnect handler
   const handlePeerDisconnect = useCallback((peerId: string) => {
    console.log(`Handling disconnect for peer ${peerId}`);
    const peerToDestroy = peerConnectionsRef.current[peerId]?.peer;

    setPeerConnections(prev => {
      if (!prev[peerId]) return prev;
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });

    if (peerToDestroy) {
        console.log(`Destroying peer object for ${peerId}`);
        try { peerToDestroy.destroy(); }
        catch (error) { console.warn(`Error destroying peer ${peerId}:`, error); }
    }

    const cleanProgress = (progressSetter: React.Dispatch<React.SetStateAction<FileTransferProgress>>, prefix: boolean) => {
        progressSetter(prev => {
            const next = {...prev};
            Object.keys(next).forEach(key => {
                const keyPeerId = prefix ? key.split('_')[0] : key.split('_').pop();
                if (keyPeerId === peerId) delete next[key];
            });
            return next;
        });
    };
    cleanProgress(setSendProgress, false);
    cleanProgress(setReceiveProgress, true);

    Object.keys(fileChunksRef.current).forEach(key => {
        if (key.startsWith(`${peerId}_`)) delete fileChunksRef.current[key];
    });
  }, []); // No dependencies needed


  // Initialize Peer Connection - uses stable functions/refs
  // ***** MODIFIED TO INCLUDE STUN SERVERS *****
  const initializePeerConnection = useCallback((peerId: string, initiator: boolean) => { // Remove initialSignal parameter
     if (peerConnectionsRef.current[peerId]?.peer) {
        console.log(`Peer connection with ${peerId} already exists or initializing.`);
        if(peerConnectionsRef.current[peerId].status === 'failed') {
            setPeerConnections(prev => ({ ...prev, [peerId]: { ...prev[peerId], status: 'connecting', isInitiator: initiator } }));
        }
        return;
     }
     console.log(`Initializing Peer connection with ${peerId}. Initiator: ${initiator}`);

    // --- START: Add STUN Server Configuration ---
    const peerConfig = {
        initiator,
        trickle: true, // Enable trickle ICE
        objectMode: false, // Use ArrayBuffer/string, not JS objects
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                // Add more public STUN servers if needed
                // { urls: 'stun:stun2.l.google.com:19302' },
                // { urls: 'stun:stun.services.mozilla.com' },
            ]
            // For production robustness, consider adding TURN servers here as well
            // Example:
            // {
            //   urls: 'turn:your.turn.server.com:3478',
            //   username: 'your-username',
            //   credential: 'your-password'
            // },
        }
    };
    // --- END: Add STUN Server Configuration ---

    // --- MODIFY: Use the peerConfig object ---
    const peer = new Peer(peerConfig);
    // --- END MODIFY ---
    // Update state immediately, setting status to 'connecting'
    const newPeerConnection: PeerConnection = {
        peerId,
        peer,
        status: 'connecting', // Start as connecting
        isInitiator: initiator,
        name: peerConnectionsRef.current[peerId]?.name || peerId // Preserve name if already known
    };
    setPeerConnections(prev => ({
      ...prev,
      [peerId]: newPeerConnection
    }));
    // --- Lines 216-217 were remnants of the broken diff, removed ---

    peer.on('signal', (data: any) => { // Add type 'any' for signal data
      const messageType = data.type === 'offer' ? 'offer' : data.type === 'answer' ? 'answer' : 'ice-candidate';
      const payloadKey = messageType === 'ice-candidate' ? 'candidate' : messageType;
      // Log state *before* sending the signal
      // Use optional chaining in case peer is destroyed during async ops
      console.log(`Peer ${peerId} state before sending ${messageType}: ${(peer as any)?._pc?.signalingState || 'N/A'}`); // Cast to any
      sendMessageToServer({ type: messageType, target: peerId, [payloadKey]: data });
    });

    // Initial signal processing is now handled outside this function by handleSignalingMessage

    peer.on('connect', () => {
      console.log(`WebRTC connection established with ${peerId}`);
      setPeerConnections(prev => {
          if (!prev[peerId]) return prev;
          // Update status correctly from 'connecting' or 'pending_approval'
          return {...prev, [peerId]: { ...prev[peerId], status: 'connected' }};
      });
      // Use functional update for setIsConnectingPeer to avoid needing it as dependency
      setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
      addChatMessage(`Connected with ${peerConnectionsRef.current[peerId]?.name || peerId}`, 'system');

      // Send user info after connection
      const userInfoPayload = JSON.stringify({ type: 'user-info', name: userNameRef.current });
      try { peer.send(userInfoPayload); } catch (error) { console.error(`Failed to send user-info to ${peerId}:`, error); }

    });

    peer.on('data', (data: any) => { // Add type 'any' for received data
      try {
        let message;
        if (data instanceof ArrayBuffer) message = JSON.parse(new TextDecoder().decode(data));
        else if (typeof data === 'string') message = JSON.parse(data);
        else message = JSON.parse(data.toString());
        handlePeerData(peerId, message); // handlePeerData needs to be defined below or memoized separately
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error, data.toString());
        addChatMessage(`Received invalid data from ${peerId}.`, 'system');
      }
    });

    peer.on('error', (err: Error) => { // Add type 'Error' for error object
      console.error(`Peer ${peerId} error:`, err);
      setPeerConnections(prev => {
          if (!prev[peerId]) return prev;
          return {...prev, [peerId]: { ...prev[peerId], status: 'failed' }};
      });
      setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
      addChatMessage(`Connection error with ${peerId}. Check console & network.`, 'system'); // Added more info
      handlePeerDisconnect(peerId); // Clean up fully on error
    });

    peer.on('close', () => {
      console.log(`Peer ${peerId} connection closed.`);
      if (peerConnectionsRef.current[peerId]) {
          addChatMessage(`Connection closed with ${peerId}.`, 'system');
          handlePeerDisconnect(peerId);
      }
       setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
    });
      // --- MOVED PEER EVENT HANDLERS BACK INSIDE useCallback ---
      // REMOVED DUPLICATE peer.on('signal') handler block (lines 274-279) as it was added erroneously before.
      // The handler defined around line 215 is the correct one.

      // Initial signal processing is now handled outside this function by handleSignalingMessage

      // --- Removed duplicate event handlers (connect, data, error, close) ---
      // --- END MOVED PEER EVENT HANDLERS ---

  // Update dependencies: added setPeerConnections, setIsConnectingPeer
  }, [addChatMessage, handlePeerDisconnect, sendMessageToServer, setPeerConnections, setIsConnectingPeer, userNameRef]);


  // --- Stable Signaling Message Handler ---
  // Uses refs for state access, depends only on stable functions
  const handleSignalingMessage = useCallback((message: any) => {
    const { type, peerId, source } = message;
    const currentUserId = userIdRef.current; // Read from ref
    const currentConnectingPeer = isConnectingPeerRef.current; // Read from ref

    const updatePeerStatus = (targetPeerId: string, status: PeerConnection['status']) => {
        setPeerConnections(prev => {
            if (!prev[targetPeerId]) return prev;
            return { ...prev, [targetPeerId]: { ...prev[targetPeerId], status } };
        });
        // Use functional update for setIsConnectingPeer
        if (targetPeerId === currentConnectingPeer && (status === 'failed' || status === 'connected')) {
             setIsConnectingPeer(prevConnecting => prevConnecting === targetPeerId ? null : prevConnecting);
        }
    };

    switch (type) {
        case 'connection-success':
            console.log(`WebSocket connection confirmed for user ID: ${message.userId}`);
            break;

        case 'peer-found':
            console.log(`Server found peer ${peerId}. Updating status to pending approval.`);
            // Update status for the initiator now that peer is confirmed
            setPeerConnections(prev => {
                const conn = prev[peerId];
                // Update only if we are the initiator and status is 'connecting'
                if (conn && conn.isInitiator && conn.status === 'connecting') {
                    return { ...prev, [peerId]: { ...conn, status: 'pending_approval' } };
                }
                return prev;
            });
            break;

        case 'connection-request':
            const senderName = message.name || peerId;
            const autoAccept = message.autoAccept === true;
            console.log(`Received connection request from ${senderName} (${peerId}). Auto-accept: ${autoAccept}`);

            // Always store the peer info temporarily
             setPeerConnections(prev => ({
                ...prev,
                [peerId]: {
                    ...(prev[peerId]), // Keep existing peer object if reconnecting/error state
                    peerId: peerId,
                    name: senderName,
                    // Set initial status based on autoAccept
                    status: autoAccept ? 'connecting' : 'pending_approval',
                    isInitiator: false
                }
            }));

            if (autoAccept) {
                // Auto-accept: Initialize the connection immediately (offer signal will follow)
                console.log(`Auto-accepting connection from ${peerId}.`);
                initializePeerConnection(peerId, false);
            } else {
                // Manual accept needed: Add to incoming requests list
                console.log(`Adding ${peerId} to incoming requests for manual approval.`);
                setIncomingRequests(prev => ({ ...prev, [peerId]: { peerId } }));
            }
            break;

        case 'peer-disconnected':
            console.log(`Peer ${peerId} disconnected (server notification).`);
            if (peerConnectionsRef.current[peerId]) {
                handlePeerDisconnect(peerId);
                addChatMessage(`Peer ${peerId} disconnected.`, 'system');
            }
            break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
            const targetPeerId = source;
            const currentPeerConn = peerConnectionsRef.current[targetPeerId];

            if (currentPeerConn?.peer) {
                // Peer object exists, relay signal directly
                const signalData = message.offer || message.answer || message.candidate;
                if (signalData) {
                    try {
                        // Use optional chaining for safety
                        console.log(`Relaying ${type} to existing peer ${targetPeerId}. Current state: ${(currentPeerConn.peer as any)?._pc?.signalingState || 'N/A'}`); // Cast to any
                        currentPeerConn.peer.signal(signalData);
                        console.log(`Peer ${targetPeerId} state after signaling ${type}: ${(currentPeerConn.peer as any)?._pc?.signalingState || 'N/A'}`); // Cast to any
                    } catch (err) {
                        console.error(`Error signaling ${type} to existing peer ${targetPeerId}:`, err);
                        updatePeerStatus(targetPeerId, 'failed');
                        addChatMessage(`Signaling error with ${targetPeerId}.`, 'system');
                    }
                } else {
                    console.warn("Received signal message without payload:", message);
                }
            } else {
                 // Peer object doesn't exist locally yet
                 if (type === 'offer') {
                     // Received an offer. Check the connection status.
                     const connectionStatus = peerConnectionsRef.current[targetPeerId]?.status;
                     const isPendingManualApproval = connectionStatus === 'pending_approval';
                     console.log(`Received offer from ${targetPeerId}. Current status: ${connectionStatus}`);

                     if (isPendingManualApproval) {
                         console.log(`Storing offer for manually pending peer ${targetPeerId}.`);
                         // Store the offer data within the existing peer connection state
                         setPeerConnections(prev => {
                             if (!prev[targetPeerId] || prev[targetPeerId].status !== 'pending_approval') return prev;
                             return { ...prev, [targetPeerId]: { ...prev[targetPeerId], offerData: message.offer } };
                         });
                         // Also update the corresponding entry in incomingRequests state for consistency, if it exists
                         setIncomingRequests(prev => {
                             if (!prev[targetPeerId]) return prev; // Ensure request exists
                             return { ...prev, [targetPeerId]: { ...prev[targetPeerId], offerData: message.offer } };
                         });
                         // DO NOT initialize or signal peer here if manual approval is pending
                     } else {
                         // If status is not 'pending_approval', assume auto-accept or direct connection.
                         // Initialize peer if it doesn't exist or failed previously.
                         console.log(`Offer received for ${targetPeerId} (not pending manual approval). Initializing/Signaling.`);
                         if (!peerConnectionsRef.current[targetPeerId] || ['failed', 'disconnected'].includes(peerConnectionsRef.current[targetPeerId].status)) {
                             initializePeerConnection(targetPeerId, false); // Initialize if needed
                         }

                         // Schedule processing the offer slightly later to allow initialization
                         setTimeout(() => {
                             const conn = peerConnectionsRef.current[targetPeerId];
                             if (conn?.peer && message.offer) {
                                 console.log(`[Auto Accept/Direct Flow] Signaling received offer to peer ${targetPeerId}`);
                                 try {
                                     console.log(`[Auto Accept/Direct Flow] Peer state before signaling offer: ${(conn.peer as any)?._pc?.signalingState || 'N/A'}`);
                                     conn.peer.signal(message.offer);
                                     console.log(`[Auto Accept/Direct Flow] Peer state after signaling offer: ${(conn.peer as any)?._pc?.signalingState || 'N/A'}`);
                                 } catch (err) {
                                     console.error(`[Auto Accept/Direct Flow] Error signaling received offer to ${targetPeerId}:`, err);
                                     updatePeerStatus(targetPeerId, 'failed');
                                     addChatMessage(`Signaling error with ${targetPeerId}.`, 'system');
                                 }
                             } else {
                                 console.warn(`[Auto Accept/Direct Flow] Peer object for ${targetPeerId} not found/ready shortly after initialization, cannot process offer.`);
                             }
                         }, 50); // Small delay
                     }
                 } else {
                     // Received answer or ICE candidate before offer/peer object creation? Should not happen.
                     console.warn(`Received ${type} for unknown or inactive peer: ${targetPeerId}`);
                 }
             }
            break;

        case 'error':
            console.error('Server error:', message.message);
            setServerError(`Server Error: ${message.message}`);
            // If the error is about a peer not being found during connection request
            if (message.message.includes("not found or offline") && currentConnectingPeer && message.message.includes(currentConnectingPeer)) {
                 console.log(`Peer ${currentConnectingPeer} not found, cleaning up connection attempt.`);
                 handlePeerDisconnect(currentConnectingPeer); // Use the disconnect handler for cleanup
                 addChatMessage(`Peer ${currentConnectingPeer} not found.`, 'system');
            } else if (currentConnectingPeer && message.message.includes(currentConnectingPeer)) {
                // Handle other errors related to the connecting peer
                 updatePeerStatus(currentConnectingPeer, 'failed');
            }
            break;

        case 'connection-declined':
            const declinedByPeerId = source; // 'source' is the peer who declined
            console.log(`Connection request to ${declinedByPeerId} was declined.`);
            addChatMessage(`Your connection request to ${peerConnectionsRef.current[declinedByPeerId]?.name || declinedByPeerId} was declined.`, 'system');
            // Clean up the failed/pending attempt for the declined peer
            setPeerConnections(prev => {
                if (!prev[declinedByPeerId]) return prev;
                const updated = { ...prev };
                delete updated[declinedByPeerId];
                return updated;
            });
             setIsConnectingPeer(currentPeer => currentPeer === declinedByPeerId ? null : currentPeer); // Clear loading if it was this peer
            break;

        default:
            console.warn('Unknown message type received from server:', type);
    }
  // Depends only on stable functions
  }, [initializePeerConnection, handlePeerDisconnect, addChatMessage]); // Added addChatMessage dependency


  // --- Initialization and WebSocket Connection (RUNS ONCE) ---
  useEffect(() => {
    let isMounted = true;
    let localSocket: WebSocket | null = null;

    const initialize = async () => {
      try {
        console.log("Fetching user ID...");
        const response = await fetch(`${API_BASE_URL}/generate-id`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const id = data.id;
        console.log("User ID received:", id);

        if (!isMounted) return;

        setUserId(id); // Update state AND ref via its own effect

        const baseUrl = window.location.origin + window.location.pathname.replace(/\/$/, '');
        setShareLink(`${baseUrl}?peer=${id}`);

        const wsUrl = `${SIGNALING_SERVER_URL}/ws/${id}`;
        console.log(`Attempting to connect WebSocket: ${wsUrl}`);
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;
        localSocket = socket;

        socket.onopen = () => {
          if (!isMounted) return;
          console.log('WebSocket connected');
          setSocketConnected(true);
          setServerError(null);

          const urlParams = new URLSearchParams(window.location.search);
          const peerToConnect = urlParams.get('peer');
          // Use userIdRef.current here as userId state might not be updated yet
          if (peerToConnect && peerToConnect !== userIdRef.current) {
            console.log(`Found peer ID in URL: ${peerToConnect}. Requesting connection...`);
            // --- MODIFICATION START: Pass forceConnect flag ---
            requestPeerConnection(peerToConnect, true); // Pass true since socket is confirmed open
            // --- MODIFICATION END ---
          }
        };

        socket.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const message = JSON.parse(event.data);
            handleSignalingMessage(message); // Call stable handler
          } catch (error) {
            console.error('Failed to parse message or handle signaling:', error);
            setServerError("Received invalid data from server.");
          }
        };

        socket.onerror = (error) => {
          if (!isMounted) return;
          console.error('WebSocket error:', error);
          setServerError('Signaling server connection error.');
          setSocketConnected(false);
        };

        socket.onclose = (event) => {
          if (!isMounted) return;
          console.log('WebSocket disconnected:', event.code, event.reason);
          setSocketConnected(false);
          setServerError(event.reason || 'Disconnected from signaling server.');
          Object.values(peerConnectionsRef.current).forEach(conn => conn.peer?.destroy());
          setPeerConnections({});
          setSendProgress({});
          setReceiveProgress({});
          setIsConnectingPeer(null);
          socketRef.current = null;
        };

      } catch (error) {
        if (!isMounted) return;
        console.error('Initialization failed:', error);
        setServerError('Failed to initialize connection. Please refresh.');
      }
    };

    initialize();

    return () => {
      isMounted = false;
      console.log("Cleaning up Share component effect...");
      if (localSocket) {
        localSocket.onopen = null;
        localSocket.onmessage = null;
        localSocket.onerror = null;
        localSocket.onclose = null;
        localSocket.close();
      }
      socketRef.current = null;
      Object.values(peerConnectionsRef.current).forEach(conn => {
        try { conn.peer?.destroy(); } catch (e) {} // Ignore errors on cleanup destroy
      });
    };
  // --->>>>>> CORE FIX: Empty dependency array ensures this runs only ONCE <<<---
  }, []);


  // --- Stable function to request connection ---
  const requestPeerConnection = useCallback((peerIdToConnect: string, forceConnect: boolean = false) => { // Add forceConnect flag
    peerIdToConnect = peerIdToConnect.trim();
    const currentUserId = userIdRef.current; // Use ref
// --- MODIFICATION START: Check if name is set (only if not forceConnect) ---
if (!isNameSet && !forceConnect) {
    setServerError("Please set your name before connecting.");
    return;
}
// --- MODIFICATION END ---

    if (!peerIdToConnect || peerIdToConnect === currentUserId) {
      setServerError("Invalid Peer ID.");
      return;
    }
    if (peerConnectionsRef.current[peerIdToConnect]) {
      setServerError(`Already connected or connecting to ${peerIdToConnect}.`);
      return;
    }
    // --- MODIFICATION START: Bypass check if forceConnect is true ---
    if (!socketConnected && !forceConnect) {
        setServerError("Not connected to signaling server.");
    // --- MODIFICATION END ---
        return;
    }

    console.log(`Requesting connection to peer: ${peerIdToConnect}`);
    setIsConnectingPeer(peerIdToConnect); // Set loading state
    setServerError(null);

    initializePeerConnection(peerIdToConnect, true); // Initialize peer object and start signaling
    // Update the status immediately after initializing to show pending state
    // Status is set to 'connecting' inside initializePeerConnection
    // It will be updated to 'pending_approval' upon receiving 'peer-found' from server

    sendMessageToServer({ type: 'request-peer-connection', peerId: peerIdToConnect, name: userNameRef.current, autoAccept: forceConnect }); // Add autoAccept flag
    setPeerIdInput('');
  // Depends only on stable functions and socketConnected state (which doesn't change often)
  }, [socketConnected, initializePeerConnection, sendMessageToServer, isNameSet]); // Add isNameSet dependency


  // --- UI triggered disconnect ---
  const disconnectFromPeer = useCallback((peerId: string) => {
    console.log(`UI Disconnecting from peer ${peerId}`);
    handlePeerDisconnect(peerId); // Call stable handler
    addChatMessage(`Disconnected from ${peerId}.`, 'system'); // Call stable handler
  }, [handlePeerDisconnect, addChatMessage]);


  // --- MODIFICATION START: Accept/Decline Handlers ---
  const handleAcceptRequest = useCallback((peerId: string) => {
    // Get the connection metadata and stored offer from the ref
    const connectionData = peerConnectionsRef.current[peerId];
    const offerToSignal = connectionData?.offerData;

    // 1. Validate State
    if (!connectionData || connectionData.status !== 'pending_approval') {
        console.error(`Cannot accept request for ${peerId}: Connection not found or not in 'pending_approval' state (Current state: ${connectionData?.status}).`);
        setIncomingRequests(prev => { const next = {...prev}; if (next[peerId]) delete next[peerId]; return next; }); // Clean UI
        return;
    }
    if (!offerToSignal) {
        console.error(`Cannot accept request for ${peerId}: Offer data was missing from stored peer connection state.`);
        addChatMessage(`Error accepting ${peerId}: Missing offer signal.`, 'system');
        setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } } : prev);
        setIncomingRequests(prev => { const next = {...prev}; if (next[peerId]) delete next[peerId]; return next; }); // Clean UI
        return;
    }

    console.log(`Accepting connection request from ${peerId}. Initializing peer and signaling stored offer.`);

    // 2. Remove from incoming requests UI state
    setIncomingRequests(prev => {
        const next = {...prev};
        delete next[peerId];
        return next;
    });

    // 3. Initialize the Peer Connection *now*
    // Note: initializePeerConnection sets status to 'connecting' internally
    initializePeerConnection(peerId, false);

    // 4. Schedule signaling the stored offer shortly after initialization
    setTimeout(() => {
        const newlyInitializedConn = peerConnectionsRef.current[peerId];
        if (newlyInitializedConn?.peer) {
            console.log(`[Manual Accept Flow] Signaling stored offer to newly initialized peer ${peerId}`);
            try {
                // Log state before signaling
                console.log(`[Manual Accept Flow] Peer state before signaling offer: ${(newlyInitializedConn.peer as any)?._pc?.signalingState || 'N/A'}`);

                // Signal the stored offer
                newlyInitializedConn.peer.signal(offerToSignal);

                // Log state after signaling
                console.log(`[Manual Accept Flow] Peer state after signaling offer: ${(newlyInitializedConn.peer as any)?._pc?.signalingState || 'N/A'}`);

                // Clear the offerData from state after successful signaling attempt
                setPeerConnections(prev => {
                    // Check if the peer still exists and hasn't changed status drastically
                    if (prev[peerId]?.status === 'connecting') {
                         return { ...prev, [peerId]: { ...prev[peerId], offerData: undefined } };
                    }
                    return prev; // Return previous state if status changed (e.g., failed)
                });

            } catch (err) {
                console.error(`[Manual Accept Flow] Error signaling stored offer to ${peerId}:`, err);
                // Update status to failed and clear offerData
                setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } } : prev);
                addChatMessage(`Signaling error accepting ${peerId}.`, 'system');
            }
        } else {
            console.warn(`[Manual Accept Flow] Peer object for ${peerId} not found shortly after initialization during accept. Cannot process offer.`);
            // Optionally set status to failed if peer object is missing after timeout
             setPeerConnections(prev => {
                 if (prev[peerId] && prev[peerId].status === 'connecting') { // Only fail if it was trying to connect
                      return { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } };
                 }
                 return prev;
             });
             addChatMessage(`Initialization error accepting ${peerId}.`, 'system');
        }
    }, 50); // Small delay to allow state updates/initialization

  }, [initializePeerConnection, addChatMessage]); // Keep initializePeerConnection and addChatMessage dependencies

  const handleDeclineRequest = useCallback((peerId: string) => {
    console.log(`Declining connection request from ${peerId}`);
    setIncomingRequests(prev => {
        const next = {...prev};
        delete next[peerId];
        return next;
    });
    sendMessageToServer({ type: 'decline-connection', target: peerId });
  }, [sendMessageToServer]);
  // --- MODIFICATION END ---


  // --- Accept/Decline Handlers ---
  // --- Peer Data Handling (Files & Chat) ---
  const handlePeerData = useCallback((peerId: string, message: any) => {
    const { type } = message;

    if (type === 'chat') {
      // Use the stored name if available, otherwise the ID
      // const senderName = peerConnectionsRef.current[peerId]?.name ?? peerId; // Name lookup now happens in addChatMessage
      addChatMessage(message.text, peerId); // addChatMessage will now handle name lookup
    } else if (type === 'user-info') {
        console.log(`Received user info from ${peerId}:`, message.name);
        const newName = message.name;
        // Update peer connection state
        setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], name: newName } } : prev);
        // Update existing chat messages from this sender
        setChatMessages(prevMessages => prevMessages.map(msg =>
            msg.sender === peerId ? { ...msg, senderName: newName } : msg
        ));
    } else if (type === 'file-info') {
      const { fileId, name, size, fileType } = message;
      console.log(`Receiving file info from ${peerId}: ${name} (${formatFileSize(size)})`);
      const transferKey = `${peerId}_${fileId}`;
      fileChunksRef.current[transferKey] = { chunks: [], receivedBytes: 0, totalSize: size, name, fileId, fileType };
      setReceiveProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'receiving', fileName: name, fileSize: size } }));
    } else if (type === 'file-chunk') {
      const { fileId, chunk, index, isLast } = message;
      const transferKey = `${peerId}_${fileId}`;
      const transferData = fileChunksRef.current[transferKey];

      if (transferData) {
        try {
            const byteString = atob(chunk);
            const byteArray = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) byteArray[i] = byteString.charCodeAt(i);

            transferData.chunks.push(byteArray);
            transferData.receivedBytes += byteArray.length;

            const progress = transferData.totalSize > 0 ? Math.round((transferData.receivedBytes / transferData.totalSize) * 100) : 0;
            if (progress % 5 === 0 || isLast) {
                setReceiveProgress(prev => {
                    const current = prev[transferKey];
                    if (current && current.status === 'receiving') return { ...prev, [transferKey]: { ...current, progress: progress } };
                    return prev;
                });
            }

            if (isLast) {
                if (transferData.receivedBytes === transferData.totalSize) {
                    console.log(`All chunks received for ${transferData.name} from ${peerId}. Reassembling...`);
                    const fileBlob = new Blob(transferData.chunks, { type: transferData.fileType || 'application/octet-stream' });
                    const senderName = peerConnectionsRef.current[peerId]?.name ?? peerId;
                    const newFile: ReceivedFile = { id: generateLocalId(), name: transferData.name, size: transferData.totalSize, blob: fileBlob, from: peerId, fromName: senderName, timestamp: Date.now() };
                    setReceivedFiles(prev => [...prev, newFile]);
                    setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], progress: 100, status: 'complete' } }));
                    delete fileChunksRef.current[transferKey];
                    addChatMessage(`Received file: ${transferData.name}`, 'system');
                } else {
                    console.warn(`Size mismatch for ${transferData.name}: ${transferData.receivedBytes}/${transferData.totalSize}`);
                     setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
                     delete fileChunksRef.current[transferKey];
                     addChatMessage(`Failed to receive file: ${transferData.name} (size mismatch)`, 'system');
                }
            }
        } catch (error) {
             console.error(`Error processing chunk for ${transferKey}:`, error);
             setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
             if(fileChunksRef.current[transferKey]) delete fileChunksRef.current[transferKey];
             addChatMessage(`Failed to process data for file: ${transferData?.name || 'unknown'}`, 'system');
        }
      } else {
        console.warn(`Received chunk for unknown/completed transfer: ${transferKey}. Index: ${index}`);
      }
    } else {
        console.warn(`Unknown data type received from peer ${peerId}: ${type}`);
    }
  }, [addChatMessage]); // Depends only on stable addChatMessage


  // --- File Handling ---
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setServerError(null);
    } else {
      setSelectedFile(null);
    }
  };

  const sendFile = useCallback(async () => {
    if (!selectedFile) { setServerError("No file selected."); return; }
    const connectedPeers = Object.values(peerConnectionsRef.current).filter(conn => conn.status === 'connected');
    if (connectedPeers.length === 0) { setServerError("No connected peers to send the file to."); return; }

    const fileId = generateLocalId();
    const fileName = selectedFile.name;
    const fileSize = selectedFile.size;
    const fileType = selectedFile.type;
    console.log(`Preparing to send file: ${fileName} (${formatFileSize(fileSize)}) to ${connectedPeers.length} peers.`);
    setServerError(null);

    const fileInfoMessage = JSON.stringify({ type: 'file-info', fileId, name: fileName, size: fileSize, fileType });
    const BUFFER_THRESHOLD = FILE_CHUNK_SIZE * 4; // 256KB buffer threshold

    // --- FIX: Set initial progress state BEFORE reading the file ---
    connectedPeers.forEach(conn => {
        const transferKey = `${fileId}_${conn.peerId}`;
        try {
            // Send file info first
            conn.peer.send(fileInfoMessage);
            // THEN update the state to 'sending'
            setSendProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'sending', fileName, fileSize } }));
            console.log(`[Setup Send] Set progress status to 'sending' for ${transferKey}`);
        } catch (error) {
             console.error(`Failed to send file-info to ${conn.peerId}:`, error);
             // Set status to failed immediately if info send fails
             setSendProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'failed', fileName, fileSize } }));
             console.log(`[Setup Send] Set progress status to 'failed' for ${transferKey} due to file-info error.`);
        }
    });
    // --- END FIX ---

    const reader = new FileReader();
    reader.onload = async (e) => {
      if (!e.target?.result) {
          console.error("FileReader error: No result");
          setServerError("Error reading the file.");
          connectedPeers.forEach(conn => setSendProgress(prev => ({ ...prev, [`${fileId}_${conn.peerId}`]: { ...prev[`${fileId}_${conn.peerId}`], status: 'failed' } })));
          return;
      }
      const buffer = e.target.result as ArrayBuffer;
      const totalChunks = Math.ceil(buffer.byteLength / FILE_CHUNK_SIZE);
      console.log(`File read into buffer. Total chunks: ${totalChunks}`);

      // State is set before reader.readAsArrayBuffer is called.
      // The onload handler closure will have access to fileId, fileName, fileSize.

      for (let i = 0; i < totalChunks; i++) {
        const start = i * FILE_CHUNK_SIZE;
        const end = Math.min(start + FILE_CHUNK_SIZE, buffer.byteLength);
        const chunkBuffer = buffer.slice(start, end);

        let base64Chunk;
        try {
            const binaryString = String.fromCharCode.apply(null, Array.from(new Uint8Array(chunkBuffer)));
            base64Chunk = btoa(binaryString);
        } catch (error) {
             console.error(`Error encoding chunk ${i} to base64:`, error);
             setServerError(`Error processing file chunk ${i+1}.`);
             // Use the captured state for setting failure here too
             connectedPeers.forEach(conn => {
                 const transferKey = `${fileId}_${conn.peerId}`;
                 setSendProgress(prev => ({ ...prev, [transferKey]: { ...(prev[transferKey] || {}), status: 'failed', fileName, fileSize } }));
             });
             return;
        }

        const chunkMessage = JSON.stringify({ type: 'file-chunk', fileId, chunk: base64Chunk, index: i, isLast: i === totalChunks - 1 });

        const sendPromises = connectedPeers.map(async (conn) => {
            const transferKey = `${fileId}_${conn.peerId}`;
            let peerStatus: PeerConnection['status'] | undefined;
            peerStatus = peerConnectionsRef.current[conn.peerId]?.status;

            console.log(`[Chunk ${i}, Peer ${conn.peerId}] Checking Peer Status: ${peerStatus}`);

            if (peerStatus === 'connected') {
                try {
                    // Introduce a small delay before sending the next chunk to act as rate limiting
                    // Adjust the delay (e.g., 10ms) as needed based on testing performance
                    await new Promise(resolve => setTimeout(resolve, 5)); // 5ms delay

                     // Re-check status in case peer disconnected while waiting
                     if (peerConnectionsRef.current[conn.peerId]?.status !== 'connected') {
                         console.log(`[Chunk ${i}, Peer ${conn.peerId}] Peer disconnected before sending chunk after delay.`);
                         throw new Error("Peer disconnected before sending chunk"); // Exit sending for this peer
                     }

                    // Attempt to send the chunk
                    conn.peer.send(chunkMessage);

                    // Calculate progress and check for completion
                    const progress = Math.round(((i + 1) / totalChunks) * 100);
                    const isComplete = i === totalChunks - 1;

                    // Update progress state periodically or on completion
                     if (progress % 5 === 0 || isComplete) {
                          setSendProgress(prev => {
                              const current = prev[transferKey];
                              // Only update if still in 'sending' state
                              if (current && current.status === 'sending') {
                                  return { ...prev, [transferKey]: { ...current, progress, status: isComplete ? 'complete' : 'sending' } };
                              }
                              return prev; // Otherwise, keep the existing state (e.g., if it became 'failed')
                          });
                     }
                     if (isComplete) {
                         console.log(`File ${fileName} sent completely to ${conn.peerId}`);
                     }
                } catch (error) {
                     console.error(`Error sending chunk ${i} to ${conn.peerId}:`, error);
                     // Set status to 'failed' on send error
                     setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
                }
            } else {
                // Log why a chunk is skipped if the peer is not connected
                console.warn(`Skipping chunk ${i} for ${conn.peerId}. Reason: Peer Status='${peerStatus}'. Expected: Peer='connected'.`);
            }
        });

        // Wait for all send attempts for the current chunk to resolve (or reject)
        await Promise.all(sendPromises);
      }

      // After loop completion
      console.log(`Finished iterating through chunks for ${fileName}`);
      addChatMessage(`Sent file: ${fileName}`, 'system');
      setSelectedFile(null); // Clear selected file state
      if (fileInputRef.current) fileInputRef.current.value = ''; // Reset file input
    };

    // Handle FileReader errors
    reader.onerror = (error) => {
      console.error("FileReader error:", error);
      setServerError("Error reading the file.");
      // Mark all associated transfers as failed if the reader fails
       connectedPeers.forEach(conn => {
           const transferKey = `${fileId}_${conn.peerId}`;
           setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed', fileName, fileSize } }));
           console.log(`[FileReader Error] Set progress status to 'failed' for ${transferKey}.`);
       });
    };

    // Start reading the file - This triggers reader.onload or reader.onerror
    reader.readAsArrayBuffer(selectedFile);
  // Depends on selectedFile state and stable functions
  }, [selectedFile, addChatMessage, sendMessageToServer]);

  const downloadFile = (fileId: string) => {
    const file = receivedFiles.find(f => f.id === fileId);
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Chat ---
  const sendChatMessage = useCallback(() => {
    if (!messageInput.trim()) return;
    const messageText = messageInput.trim();
    addChatMessage(messageText, 'me'); // addChatMessage now includes the user's name

    const chatPayload = JSON.stringify({ type: 'chat', text: messageText });
    Object.values(peerConnectionsRef.current).forEach(conn => {
      if (conn.status === 'connected') {
        try { conn.peer.send(chatPayload); }
        catch (error) {
            console.error(`Failed to send chat message to ${conn.peerId}:`, error);
            addChatMessage(`Failed to send message to ${conn.peerId}.`, 'system');
        }
      }
    });
    setMessageInput('');
  // Depends on messageInput state and stable addChatMessage
  }, [messageInput, addChatMessage]);

  // Scroll chat to bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // --- UI Helpers ---
  const copyShareLink = useCallback(() => {
    if (!shareLink) return;
    navigator.clipboard.writeText(shareLink)
      .then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); })
      .catch(err => console.error('Failed to copy link:', err));
  }, [shareLink]);

  // --- Render ---
  const connectedPeerCount = Object.values(peerConnections).filter(p => p.status === 'connected').length;
  const connectingPeerCount = Object.values(peerConnections).filter(p => p.status === 'connecting').length;

  // --- Return JSX ---
  return (
    <div className="p-4 md:p-6 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 min-h-screen transition-colors duration-300 flex flex-col md:flex-row gap-6">
        {/* Left Column */}
        <div className="w-full md:w-1/3 lg:w-1/4 flex flex-col gap-4">
            {/* User ID & Share Link */}
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
                    {socketConnected ? <Wifi className="w-5 h-5 text-green-500" /> : <WifiOff className="w-5 h-5 text-red-500" />}
                    Your Session
                </h2>
                 {isNameSet ? (
                   <p className="text-sm mb-3">Your Name: <strong className="font-semibold">{userName}</strong></p>
                ) : (
                   <div className="mb-3">
                       <label htmlFor="userNameInput" className="text-sm text-neutral-600 dark:text-neutral-400 mb-1 block">Set Your Name:</label>
                       <div className="flex gap-2">
                           <input type="text" id="userNameInput" placeholder="Enter name..." value={userName} onChange={(e) => setUserName(e.target.value)} maxLength={20}
                               className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm dark:placeholder-neutral-400 w-full"
                           />
                           <button onClick={() => {
                               const trimmedName = userName.trim();
                               if (trimmedName) {
                                   setIsNameSet(true);
                                   // Broadcast the name update to connected peers
                                   const userInfoPayload = JSON.stringify({ type: 'user-info', name: trimmedName });
                                   Object.values(peerConnectionsRef.current).forEach(conn => {
                                       if (conn.status === 'connected') {
                                           try { conn.peer.send(userInfoPayload); }
                                           catch (error) { console.error(`Failed to send user-info update to ${conn.peerId}:`, error); }
                                       }
                                   });
                               }
                           }} disabled={!userName.trim()}
                               className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50">Set</button>
                       </div>
                   </div>
                )}

                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">Your ID:</p>
                 <code className="text-sm px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded font-mono break-all block mb-3">{userId || 'Connecting...'}</code>

                 <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">Share Link:</p>
                 <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                     <input
                        type="text" readOnly value={shareLink || 'Generating...'}
                        className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-xs focus:outline-none truncate w-full"
                        onClick={(e) => isNameSet && (e.target as HTMLInputElement).select()} // Only allow select if name is set
                        disabled={!shareLink || !isNameSet} // Disable input if name not set
                    />
                     {/* --- MODIFICATION START: Disable copy button if name not set --- */}
                     <button onClick={copyShareLink} disabled={!shareLink || linkCopied || !isNameSet} title={!isNameSet ? "Set your name first" : "Copy share link"}
                        className="p-2 bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600 rounded disabled:opacity-50 self-center sm:self-auto">
                        {linkCopied ? <Check className="w-4 h-4 text-green-600 dark:text-green-400" /> : <LinkIcon className="w-4 h-4" />}
                     {/* --- MODIFICATION END --- */}
                     </button>
                 </div>
                 {serverError && ( <p className="mt-3 text-xs text-red-600 dark:text-red-400 flex items-center gap-1"> <AlertCircle className="w-3 h-3" /> {serverError} </p> )}
            </div>

            {/* Connect to Peer */}
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Connect to Peer</h2>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <input type="text" placeholder="Enter Peer ID" value={peerIdInput} onChange={(e) => setPeerIdInput(e.target.value)}
                        className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm dark:placeholder-neutral-400 w-full"
                        disabled={!socketConnected || !!isConnectingPeer || !isNameSet} // Disable if name not set
                        onKeyPress={(e) => e.key === 'Enter' && isNameSet && !isConnectingPeer && peerIdInput && requestPeerConnection(peerIdInput)}
                    />
                    <button onClick={() => requestPeerConnection(peerIdInput)}
                        disabled={!socketConnected || !peerIdInput || !!isConnectingPeer || !!peerConnections[peerIdInput] || !isNameSet} // Disable if name not set
                        className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center w-full sm:w-[80px]">
                        {isConnectingPeer === peerIdInput ? <Loader2 className="w-4 h-4 animate-spin" /> : "Connect"}
                    </button>
                </div>
            </div>

            {/* Incoming Connection Requests */}
            {Object.keys(incomingRequests).length > 0 && (
                <div className="p-4 border border-yellow-400 dark:border-yellow-600 rounded-md bg-yellow-50 dark:bg-yellow-900/30">
                    <h2 className="text-lg font-semibold mb-2 text-yellow-800 dark:text-yellow-300">Incoming Requests</h2>
                    <ul className="space-y-2">
                        {Object.values(incomingRequests).map(({ peerId }) => (
                            <li key={peerId} className="flex items-center justify-between text-sm p-1.5 bg-white dark:bg-neutral-700 rounded shadow-sm">
                                <span className="font-medium truncate" title={peerId}>{peerConnections[peerId]?.name || peerId}</span> {/* Use state directly */}
                                {/* Removed this line - replaced by the one above */}
                                <div className="flex gap-2">
                                    <button onClick={() => handleAcceptRequest(peerId)} title="Accept" className="p-1 text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 rounded hover:bg-green-100 dark:hover:bg-green-800"> <Check className="w-4 h-4" /> </button>
                                    <button onClick={() => handleDeclineRequest(peerId)} title="Decline" className="p-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 rounded hover:bg-red-100 dark:hover:bg-red-800"> <X className="w-4 h-4" /> </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Connected Peers */}
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800 flex-grow overflow-y-auto min-h-[150px]">
                 <h2 className="text-lg font-semibold mb-2 flex items-center gap-2"> <Users className="w-5 h-5" /> Peers ({connectedPeerCount}) {connectingPeerCount > 0 && <Loader2 className="w-4 h-4 animate-spin text-neutral-500" />} </h2>
                 {Object.keys(peerConnections).length === 0 ? ( <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">No peers connected.</p> ) : (
                    <ul className="space-y-2">
                        {Object.values(peerConnections).map(({ peerId, status, name }) => (
                            <li key={peerId} className="flex items-center justify-between text-sm p-1.5 bg-neutral-100 dark:bg-neutral-700 rounded">
                                <div className="flex items-center gap-2 truncate">
                                     <span className={`w-2 h-2 rounded-full ${ status === 'connected' ? 'bg-green-500' : status === 'connecting' || status === 'pending_approval' ? 'bg-yellow-500 animate-pulse' : status === 'failed' ? 'bg-red-500' : 'bg-neutral-400' }`}></span>
                                     <span className="font-medium text-sm truncate" title={peerId}>{name || peerId}</span>
                                     {status === 'connecting' && isConnectingPeer !== peerId && <Loader2 className="w-3 h-3 animate-spin text-neutral-500" />}
                                     {status === 'failed' && <AlertCircle className="w-3 h-3 text-red-500" />}
                                </div>
                                <button onClick={() => disconnectFromPeer(peerId)} title="Disconnect" className="p-1 text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400 rounded hover:bg-neutral-200 dark:hover:bg-neutral-600"> <X className="w-4 h-4" /> </button>
                            </li>
                        ))}
                    </ul>
                 )}
            </div>
        </div>

        {/* Right Column */}
        <div className="w-full md:w-2/3 lg:w-3/4 flex flex-col gap-4">
            {/* File Transfer Area */}
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                 <h2 className="text-lg font-semibold mb-3">File Transfer</h2>
                 <div className="flex flex-col sm:flex-row items-center gap-3 mb-4">
                    <label className={`px-4 py-2 rounded border border-neutral-300 dark:border-neutral-600 cursor-pointer flex items-center gap-2 text-sm ${selectedFile ? 'bg-neutral-100 dark:bg-neutral-700' : 'bg-white dark:bg-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-500'}`}>
                        <Paperclip className="w-4 h-4" /> <span>{selectedFile ? "Change File" : "Choose File"}</span>
                        <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" disabled={connectedPeerCount === 0} />
                    </label>
                    {selectedFile && ( <span className="text-sm text-neutral-700 dark:text-neutral-300 truncate max-w-[200px]" title={selectedFile.name}> {selectedFile.name} ({formatFileSize(selectedFile.size)}) </span> )}
                    {!selectedFile && <span className="text-sm text-neutral-500 dark:text-neutral-400">No file chosen</span>}
                    <button onClick={sendFile} disabled={!selectedFile || connectedPeerCount === 0 || Object.values(sendProgress).some(p => p.status === 'sending')}
                        className="ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"> <Send className="w-4 h-4" /> Send </button>
                 </div>

                 {/* Progress Indicators */}
                 {(Object.keys(sendProgress).length > 0 || Object.keys(receiveProgress).length > 0) && (
                     <div className="mt-4 space-y-3 text-xs">
                         {/* Sending Progress */}
                         {Object.entries(sendProgress).filter(([key, p]) => p.status !== 'complete' || p.progress < 100).map(([key, { progress, status, fileName, fileSize }]) => {
                              const peerId = key.split('_').pop();
                              return (
                                  <div key={key}>
                                      <div className="flex justify-between items-center mb-0.5">
                                          <span className="font-medium truncate pr-2" title={fileName}> <Upload className="w-3 h-3 inline mr-1" /> Sending to {peerId}: {fileName} ({formatFileSize(fileSize ?? 0)}) </span>
                                          <span className={`font-mono ${status === 'failed' ? 'text-red-500' : ''}`}> {status === 'sending' ? `${progress}%` : status === 'failed' ? 'Failed' : status} </span>
                                      </div>
                                      <div className="w-full bg-neutral-200 dark:bg-neutral-600 rounded h-1.5">
                                          <div className={`h-1.5 rounded ${status === 'failed' ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${status === 'failed' ? 100 : progress}%` }} ></div>
                                      </div>
                                  </div>
                              );
                         })}
                         {/* Receiving Progress */}
                         {Object.entries(receiveProgress).filter(([key, p]) => p.status !== 'complete' || p.progress < 100).map(([key, { progress, status, fileName, fileSize }]) => {
                              const peerId = key.split('_')[0];
                              return (
                                  <div key={key}>
                                      <div className="flex justify-between items-center mb-0.5">
                                          <span className="font-medium truncate pr-2" title={fileName}> <Download className="w-3 h-3 inline mr-1" /> Receiving from {peerId}: {fileName} ({formatFileSize(fileSize ?? 0)}) </span>
                                          <span className={`font-mono ${status === 'failed' ? 'text-red-500' : ''}`}> {status === 'receiving' ? `${progress}%` : status === 'failed' ? 'Failed' : status} </span>
                                      </div>
                                      <div className="w-full bg-neutral-200 dark:bg-neutral-600 rounded h-1.5">
                                          <div className={`h-1.5 rounded ${status === 'failed' ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${status === 'failed' ? 100 : progress}%` }} ></div>
                                      </div>
                                  </div>
                              );
                         })}
                     </div>
                 )}

                 {/* Received Files List */}
                 {receivedFiles.length > 0 && (
                    <div className="mt-6">
                        <h3 className="text-md font-semibold mb-2 border-t border-neutral-300 dark:border-neutral-700 pt-3">Received Files</h3>
                        <ul className="space-y-2">
                            {receivedFiles.map((file) => (
                                <li key={file.id} className="flex items-center justify-between text-sm p-2 bg-neutral-100 dark:bg-neutral-700 rounded">
                                    <div className="truncate mr-2">
                                        <p className="font-medium truncate" title={file.name}>{file.name}</p>
                                        <p className="text-xs text-neutral-500 dark:text-neutral-400"> {formatFileSize(file.size)} from {file.fromName || file.from} ({new Date(file.timestamp).toLocaleTimeString()}) </p>
                                    </div>
                                    <button onClick={() => downloadFile(file.id)} title="Download file" className="p-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 rounded hover:bg-neutral-200 dark:hover:bg-neutral-600 flex-shrink-0"> <Download className="w-4 h-4" /> </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                 )}
            </div>

            {/* Chat Area */}
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800 flex flex-col flex-grow min-h-[200px]">
                <div className="flex justify-between items-center mb-2"> <h2 className="text-lg font-semibold flex items-center gap-2"> <MessageSquare className="w-5 h-5" /> Chat </h2> </div>
                {showChat && (
                    <>
                        <div ref={chatContainerRef} className="flex-grow overflow-y-auto mb-3 pr-2 space-y-2 text-sm">
                            {chatMessages.map((msg) => (
                                <div key={msg.id} className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[75%] p-2 rounded-lg shadow-sm ${ msg.sender === 'me' ? 'bg-blue-100 dark:bg-blue-900 text-blue-900 dark:text-blue-100' : msg.sender === 'system' ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400 text-xs italic w-full text-center py-1' : 'bg-white dark:bg-neutral-600 border border-neutral-200 dark:border-neutral-700' }`}>
                                        {msg.sender !== 'me' && msg.sender !== 'system' && ( <p className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-0.5">{msg.senderName || msg.sender}</p> )}
                                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                                    </div> { /* <-- Potential width issue here for system messages */ }
                                </div>
                            ))}
                            {connectedPeerCount === 0 && chatMessages.length === 0 && ( <p className="text-xs text-center text-neutral-500 dark:text-neutral-400 italic py-4">Connect to a peer to start chatting.</p> )}
                            {chatMessages.length === 0 && connectedPeerCount > 0 && ( <p className="text-xs text-center text-neutral-500 dark:text-neutral-400 italic py-4">Chat history is empty. Send a message!</p> )}
                        </div>
                        <div className="flex items-center gap-2 pt-2 border-t border-neutral-300 dark:border-neutral-700">
                            <input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()} placeholder={connectedPeerCount > 0 ? "Type your message..." : "Connect to a peer to chat"}
                                className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm dark:placeholder-neutral-400"
                                disabled={connectedPeerCount === 0 || !isNameSet} // Disable if name not set
                            />
                            <button onClick={sendChatMessage} disabled={!messageInput.trim() || connectedPeerCount === 0} className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"> <Send className="w-4 h-4" /> </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    </div>
  );
};

export default Share;
// --- END OF FILE Share.tsx ---

// --- Type Updates ---
interface ChatMessage {
 id: string;
 text: string;
 sender: string; // 'me', 'system', or peerId
 senderName?: string; // Display name
 timestamp: number;
}
// --- END OF FILE Share.tsx ---