import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer from 'simple-peer/simplepeer.min.js'; 
import type { Instance as PeerInstance } from 'simple-peer';
import { Upload, Download, Copy, Link as LinkIcon, Users, MessageSquare, X, Check, RefreshCw, Send, Paperclip, AlertCircle, WifiOff, Wifi, Loader2 } from 'lucide-react';
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

const SIGNALING_SERVER_URL = process.env.NODE_ENV === 'development' ? 'ws://localhost:8000' : `wss://${BACKEND_URL.replace('https://', '')}`;
const API_BASE_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : BACKEND_URL;
const FILE_CHUNK_SIZE = 128 * 1024;

interface PeerConnection {
  peerId: string;
  peer: PeerInstance;
  status: 'connecting' | 'connected' | 'failed' | 'disconnected' | 'pending_approval';
  isInitiator: boolean;
  name?: string;
  offerData?: any;
}
interface IncomingRequest {
    peerId: string;
    offerData?: any;
}
interface ChatMessage { id: string; text: string; sender: string; senderName?: string; timestamp: number; }
interface ReceivedFile { id: string; name: string; size: number; blob: Blob; from: string; fromName?: string; timestamp: number; }
interface FileTransferProgress {
  [key: string]: {
    progress: number;
    status: 'sending' | 'receiving' | 'complete' | 'failed' | 'pending' | 'declined';
    fileName?: string;
    fileSize?: number;
    peerId?: string;
    fileId?: string;
    fileType?: string;
  };
}

const generateLocalId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoiding confusing chars like 0, O, I, 1
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};
const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};


const Share: React.FC = () => {
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<Record<string, IncomingRequest>>({});
  const [messageInput, setMessageInput] = useState<string>('');
  const [showChat, setShowChat] = useState<boolean>(true);
  const [shareLink, setShareLink] = useState<string>('');
  const [linkCopied, setLinkCopied] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const socketRef = useRef<WebSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const fileChunksRef = useRef<Record<string, any>>({});
  const peerConnectionsRef = useRef(peerConnections);
  const sendFileChunksRef = useRef<((fileId: string, peerId: string) => Promise<void>) | null>(null);
  const sendProgressRef = useRef(sendProgress);
  const receiveProgressRef = useRef(receiveProgress);
  const userIdRef = useRef(userId);
  const userNameRef = useRef(userName);
  const isConnectingPeerRef = useRef(isConnectingPeer);

  useEffect(() => {
    peerConnectionsRef.current = peerConnections;
  }, [peerConnections]);
  useEffect(() => {
    sendProgressRef.current = sendProgress;
  }, [sendProgress]);
  useEffect(() => {
    receiveProgressRef.current = receiveProgress;
  }, [receiveProgress]);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);
  useEffect(() => {
    isConnectingPeerRef.current = isConnectingPeer;
  }, [isConnectingPeer]);


  const addChatMessage = useCallback((text: string, sender: string) => {
    const senderName = sender === 'me' ? userNameRef.current : peerConnectionsRef.current[sender]?.name ?? sender;
    const newMessage: ChatMessage = {
      id: generateLocalId(), text, sender, senderName, timestamp: Date.now()
    };
    setChatMessages(prev => [...prev, newMessage]);
  }, []);


  const sendMessageToServer = useCallback((message: object) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      try {
        socketRef.current.send(JSON.stringify(message));
      } catch (error) {
        console.error("Failed to send message via WebSocket:", error);
        setServerError("Failed to communicate with server.");
      }
    } else {
      console.error('Cannot send message: WebSocket not connected.');
      setServerError('Not connected to server. Please wait or refresh.');
    }
  }, []);


   const handlePeerDisconnect = useCallback((peerId: string) => {
    console.log(`Handling disconnect for peer ${peerId}`);
    
    const peerConnection = peerConnectionsRef.current[peerId];
    const peerToDestroy = peerConnection?.peer;

    setPeerConnections(prev => {
      if (!prev[peerId]) return prev;
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });

    if (peerToDestroy) {
        console.log(`Destroying peer object for ${peerId}`);
        try { 
            peerToDestroy.destroy(); 
        } catch (error) { 
            console.warn(`Error destroying peer ${peerId}:`, error); 
        }
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
  }, []);



  const initializePeerConnection = useCallback((peerId: string, initiator: boolean) => {
     if (peerConnectionsRef.current[peerId]?.peer) {
        console.log(`Peer connection with ${peerId} already exists or initializing.`);
        if(peerConnectionsRef.current[peerId].status === 'failed') {
            setPeerConnections(prev => ({ ...prev, [peerId]: { ...prev[peerId], status: 'connecting', isInitiator: initiator } }));
        }
        return;
     }
     console.log(`Initializing Peer connection with ${peerId}. Initiator: ${initiator}`);

    const peerConfig = {
        initiator,
        trickle: true,
        objectMode: false,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        }
    };

    const peer = new Peer(peerConfig);

    const newPeerConnection: PeerConnection = {
        peerId,
        peer,
        status: 'connecting',
        isInitiator: initiator,
        name: peerConnectionsRef.current[peerId]?.name || peerId
    };
    setPeerConnections(prev => ({
      ...prev,
      [peerId]: newPeerConnection
    }));

    peer.on('signal', (data: any) => {
      const messageType = data.type === 'offer' ? 'offer' : data.type === 'answer' ? 'answer' : 'ice-candidate';
      const payloadKey = messageType === 'ice-candidate' ? 'candidate' : messageType;
      console.log(`Peer ${peerId} state before sending ${messageType}: ${(peer as any)?._pc?.signalingState || 'N/A'}`);
      sendMessageToServer({ type: messageType, target: peerId, [payloadKey]: data });
    });

    peer.on('connect', () => {
      console.log(`WebRTC connection established with ${peerId}`);
      setPeerConnections(prev => {
          if (!prev[peerId]) return prev;
          return {...prev, [peerId]: { ...prev[peerId], status: 'connected' }};
      });
      setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
      addChatMessage(`Connected with ${peerConnectionsRef.current[peerId]?.name || peerId}`, 'system');

      const userInfoPayload = JSON.stringify({ type: 'user-info', name: userNameRef.current, userId: userIdRef.current });
      try { peer.send(userInfoPayload); } catch (error) { console.error(`Failed to send user-info to ${peerId}:`, error); }

      const otherPeerIds = Object.keys(peerConnectionsRef.current).filter(
          id => id !== peerId && peerConnectionsRef.current[id]?.status === 'connected'
      );
      if (otherPeerIds.length > 0) {
          try {
              peer.send(JSON.stringify({ type: 'peer-list', peers: otherPeerIds }));
              console.log(`Sent peer list to ${peerId}:`, otherPeerIds);
          } catch (error) {
              console.error(`Failed to send peer-list to ${peerId}:`, error);
          }
      }

    });

    peer.on('data', (data: any) => {
      try {
        let message;
        if (data instanceof ArrayBuffer) message = JSON.parse(new TextDecoder().decode(data));
        else if (typeof data === 'string') message = JSON.parse(data);
        else message = JSON.parse(data.toString());
        handlePeerData(peerId, message);
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error, data.toString());
        addChatMessage(`Received invalid data from ${peerId}.`, 'system');
      }
    });

    peer.on('error', (err: Error) => {
      console.error(`Peer ${peerId} error:`, err);
      setPeerConnections(prev => {
          if (!prev[peerId]) return prev;
          return {...prev, [peerId]: { ...prev[peerId], status: 'failed' }};
      });
      setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
      addChatMessage(`Connection error with ${peerId}. Check console & network.`, 'system');
      handlePeerDisconnect(peerId);
    });

    peer.on('close', () => {
      console.log(`Peer ${peerId} connection closed.`);
      if (peerConnectionsRef.current[peerId]) {
          addChatMessage(`Connection closed with ${peerConnectionsRef.current[peerId]?.name || peerId}.`, 'system');
          handlePeerDisconnect(peerId);
      }
      setIsConnectingPeer(currentPeer => currentPeer === peerId ? null : currentPeer);
    });

  }, [addChatMessage, handlePeerDisconnect, sendMessageToServer, setPeerConnections, setIsConnectingPeer, userNameRef]);


  const handleSignalingMessage = useCallback((message: any) => {
    const { type, peerId, source } = message;
    const currentUserId = userIdRef.current;
    const currentConnectingPeer = isConnectingPeerRef.current;

    const updatePeerStatus = (targetPeerId: string, status: PeerConnection['status']) => {
        setPeerConnections(prev => {
            if (!prev[targetPeerId]) return prev;
            return { ...prev, [targetPeerId]: { ...prev[targetPeerId], status } };
        });
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
            setPeerConnections(prev => {
                const conn = prev[peerId];
                if (conn && conn.isInitiator && conn.status === 'connecting') {
                    return { ...prev, [peerId]: { ...conn, status: 'pending_approval' } };
                }
                return prev;
            });
            break;

        case 'connection-request':
            const senderName = message.name || peerId;
            const autoAccept = message.autoAccept === true;
            console.log(`Received 'connection-request' from ${senderName} (${peerId}). Payload:`, message);
            console.log(` -> Parsed autoAccept flag: ${autoAccept}`);

             setPeerConnections(prev => ({
                ...prev,
                [peerId]: {
                    ...(prev[peerId]),
                    peerId: peerId,
                    name: senderName,
                    status: autoAccept ? 'connecting' : 'pending_approval',
                    isInitiator: false
                }
            }));

            if (autoAccept) {
                console.log(`Auto-accepting connection from ${peerId}.`);
                initializePeerConnection(peerId, false);
            } else {
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
                const signalData = message.offer || message.answer || message.candidate;
                if (signalData) {
                    try {
                        console.log(`Relaying ${type} to existing peer ${targetPeerId}. Current state: ${(currentPeerConn.peer as any)?._pc?.signalingState || 'N/A'}`);
                        currentPeerConn.peer.signal(signalData);
                        console.log(`Peer ${targetPeerId} state after signaling ${type}: ${(currentPeerConn.peer as any)?._pc?.signalingState || 'N/A'}`);
                    } catch (err) {
                        console.error(`Error signaling ${type} to existing peer ${targetPeerId}:`, err);
                        updatePeerStatus(targetPeerId, 'failed');
                        addChatMessage(`Signaling error with ${targetPeerId}.`, 'system');
                    }
                } else {
                    console.warn("Received signal message without payload:", message);
                }
            } else {
                 if (type === 'offer') {
                     const connectionStatus = peerConnectionsRef.current[targetPeerId]?.status;
                     const isPendingManualApproval = connectionStatus === 'pending_approval';
                     console.log(`Received offer from ${targetPeerId}. Current status: ${connectionStatus}`);

                     if (isPendingManualApproval) {
                         console.log(`Storing offer for manually pending peer ${targetPeerId}.`);
                         setPeerConnections(prev => {
                             if (!prev[targetPeerId] || prev[targetPeerId].status !== 'pending_approval') return prev;
                             return { ...prev, [targetPeerId]: { ...prev[targetPeerId], offerData: message.offer } };
                         });
                         setIncomingRequests(prev => {
                             if (!prev[targetPeerId]) return prev;
                             return { ...prev, [targetPeerId]: { ...prev[targetPeerId], offerData: message.offer } };
                         });
                     } else {
                         console.log(`Offer received for ${targetPeerId} (not pending manual approval). Initializing/Signaling.`);
                         if (!peerConnectionsRef.current[targetPeerId] || ['failed', 'disconnected'].includes(peerConnectionsRef.current[targetPeerId].status)) {
                             initializePeerConnection(targetPeerId, false);
                         }

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
                         }, 50);
                     }
                 } else {
                     console.warn(`Received ${type} for unknown or inactive peer: ${targetPeerId}`);
                 }
             }
            break;

        case 'error':
            console.error('Server error:', message.message);
            setServerError(`Server Error: ${message.message}`);
            if (message.message.includes("not found or offline") && currentConnectingPeer && message.message.includes(currentConnectingPeer)) {
                 console.log(`Peer ${currentConnectingPeer} not found, cleaning up connection attempt.`);
                 handlePeerDisconnect(currentConnectingPeer);
                 addChatMessage(`Peer ${currentConnectingPeer} not found.`, 'system');
            } else if (currentConnectingPeer && message.message.includes(currentConnectingPeer)) {
                 updatePeerStatus(currentConnectingPeer, 'failed');
            }
            break;

        case 'connection-declined':
            const declinedByPeerId = source;
            console.log(`Connection request to ${declinedByPeerId} was declined.`);
            addChatMessage(`Your connection request to ${peerConnectionsRef.current[declinedByPeerId]?.name || declinedByPeerId} was declined.`, 'system');
            setPeerConnections(prev => {
                if (!prev[declinedByPeerId]) return prev;
                const updated = { ...prev };
                delete updated[declinedByPeerId];
                return updated;
            });
             setIsConnectingPeer(currentPeer => currentPeer === declinedByPeerId ? null : currentPeer);
            break;

        default:
            console.warn('Unknown message type received from server:', type);
    }
  }, [initializePeerConnection, handlePeerDisconnect, addChatMessage]);


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

        setUserId(id);

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
          if (peerToConnect && peerToConnect !== userIdRef.current) {
            console.log(`Found peer ID in URL: ${peerToConnect}. Requesting connection...`);
            requestPeerConnection(peerToConnect, true);
          }
        };

        socket.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const message = JSON.parse(event.data);
            handleSignalingMessage(message);
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
        try { conn.peer?.destroy(); } catch (e) {}
      });
    };
  }, []);


  const requestPeerConnection = useCallback((peerIdToConnect: string, forceConnect: boolean = false) => {
    peerIdToConnect = peerIdToConnect.trim();
    const currentUserId = userIdRef.current;
if (!isNameSet && !forceConnect) {
    setServerError("Please set your name before connecting.");
    return;
}

    if (!peerIdToConnect || peerIdToConnect === currentUserId) {
      setServerError("Invalid Peer ID.");
      return;
    }
    if (peerConnectionsRef.current[peerIdToConnect]) {
      setServerError(`Already connected or connecting to ${peerIdToConnect}.`);
      return;
    }
    if (!socketConnected && !forceConnect) {
        setServerError("Not connected to signaling server.");
        return;
    }

    console.log(`Requesting connection to peer: ${peerIdToConnect}`);
    setIsConnectingPeer(peerIdToConnect);
    setServerError(null);

    initializePeerConnection(peerIdToConnect, true);

    sendMessageToServer({ type: 'request-peer-connection', peerId: peerIdToConnect, name: userNameRef.current, autoAccept: forceConnect });
    setPeerIdInput('');
  }, [socketConnected, initializePeerConnection, sendMessageToServer, isNameSet]);


  const disconnectFromPeer = useCallback((peerId: string) => {
    console.log(`UI Disconnecting from peer ${peerId}`);
    handlePeerDisconnect(peerId);
    addChatMessage(`Disconnected from ${peerId}.`, 'system');
  }, [handlePeerDisconnect, addChatMessage]);


  const handleAcceptRequest = useCallback((peerId: string) => {
    const connectionData = peerConnectionsRef.current[peerId];
    const offerToSignal = connectionData?.offerData;

    if (!connectionData || connectionData.status !== 'pending_approval') {
        console.error(`Cannot accept request for ${peerId}: Connection not found or not in 'pending_approval' state (Current state: ${connectionData?.status}).`);
        setIncomingRequests(prev => { const next = {...prev}; if (next[peerId]) delete next[peerId]; return next; });
        return;
    }
    if (!offerToSignal) {
        console.error(`Cannot accept request for ${peerId}: Offer data was missing from stored peer connection state.`);
        addChatMessage(`Error accepting ${peerId}: Missing offer signal.`, 'system');
        setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } } : prev);
        setIncomingRequests(prev => { const next = {...prev}; if (next[peerId]) delete next[peerId]; return next; });
        return;
    }

    console.log(`Accepting connection request from ${peerId}. Initializing peer and signaling stored offer.`);

    setIncomingRequests(prev => {
        const next = {...prev};
        delete next[peerId];
        return next;
    });

    initializePeerConnection(peerId, false);

    setTimeout(() => {
        const newlyInitializedConn = peerConnectionsRef.current[peerId];
        if (newlyInitializedConn?.peer) {
            console.log(`[Manual Accept Flow] Signaling stored offer to newly initialized peer ${peerId}`);
            try {
                console.log(`[Manual Accept Flow] Peer state before signaling offer: ${(newlyInitializedConn.peer as any)?._pc?.signalingState || 'N/A'}`);

                newlyInitializedConn.peer.signal(offerToSignal);

                console.log(`[Manual Accept Flow] Peer state after signaling offer: ${(newlyInitializedConn.peer as any)?._pc?.signalingState || 'N/A'}`);

                setPeerConnections(prev => {
                    if (prev[peerId]?.status === 'connecting') {
                         return { ...prev, [peerId]: { ...prev[peerId], offerData: undefined } };
                    }
                    return prev;
                });

            } catch (err) {
                console.error(`[Manual Accept Flow] Error signaling stored offer to ${peerId}:`, err);
                setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } } : prev);
                addChatMessage(`Signaling error accepting ${peerId}.`, 'system');
            }
        } else {
            console.warn(`[Manual Accept Flow] Peer object for ${peerId} not found shortly after initialization during accept. Cannot process offer.`);
             setPeerConnections(prev => {
                 if (prev[peerId] && prev[peerId].status === 'connecting') {
                      return { ...prev, [peerId]: { ...prev[peerId], status: 'failed', offerData: undefined } };
                 }
                 return prev;
             });
             addChatMessage(`Initialization error accepting ${peerId}.`, 'system');
        }
    }, 50);

  }, [initializePeerConnection, addChatMessage]);

  const handleDeclineRequest = useCallback((peerId: string) => {
    console.log(`Declining connection request from ${peerId}`);
    setIncomingRequests(prev => {
        const next = {...prev};
        delete next[peerId];
        return next;
    });
    sendMessageToServer({ type: 'decline-connection', target: peerId });
  }, [sendMessageToServer]);


  const handlePeerData = useCallback((peerId: string, message: any) => {
    const { type } = message;

    if (type === 'chat') {
      addChatMessage(message.text, peerId);
    } else if (type === 'user-info') {
        console.log(`Received user info from ${peerId}:`, message.name);
        const newName = message.name;
        setPeerConnections(prev => prev[peerId] ? { ...prev, [peerId]: { ...prev[peerId], name: newName } } : prev);
        setChatMessages(prevMessages => prevMessages.map(msg =>
            msg.sender === peerId ? { ...msg, senderName: newName } : msg
        ));
    } else if (type === 'peer-list') {
        console.log(`Received peer list from ${peerId}:`, message.peers);
        message.peers?.forEach((idToConnect: string) => {
            if (
                idToConnect !== userIdRef.current &&
                !peerConnectionsRef.current[idToConnect] &&
                !incomingRequests[idToConnect]
            ) {
                console.log(`[Mesh] Connecting to peer from received list: ${idToConnect}`);
                setTimeout(() => initializePeerConnection(idToConnect, true), Math.random() * 300 + 50);
            }
        });
    } else if (type === 'file-info') {
      const { fileId, name, size, fileType } = message;
      console.log(`Receiving file info from ${peerId}: ${name} (${formatFileSize(size)})`);
      const transferKey = `${peerId}_${fileId}`;
      setReceiveProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'pending', fileName: name, fileSize: size, peerId, fileId, fileType } }));
    } else if (type === 'file-chunk') {
      const { fileId, chunk, index, isLast } = message;
      const transferKey = `${peerId}_${fileId}`;
      const transferData = fileChunksRef.current[transferKey];
      const progressData = receiveProgressRef.current[transferKey];

      console.log(`[Chunk ${index}] Received for ${transferKey}. TransferData exists: ${!!transferData}, Progress status: ${progressData?.status}`);

      if (transferData && progressData && progressData.status === 'receiving') {
        try {
            const byteString = atob(chunk);
            const byteArray = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) byteArray[i] = byteString.charCodeAt(i);

            transferData.chunks.push(byteArray);
            transferData.receivedBytes += byteArray.length;

            const ackMessage = JSON.stringify({ type: 'chunk-ack', fileId, index });
            const senderConn = peerConnectionsRef.current[peerId];
            if (senderConn?.peer && senderConn.status === 'connected') {
                try {
                    senderConn.peer.send(ackMessage);
                } catch (error) {
                    console.error(`Failed to send chunk acknowledgment to ${peerId}:`, error);
                }
            }

            const progress = transferData.totalSize > 0 ? Math.round((transferData.receivedBytes / transferData.totalSize) * 100) : 0;
            if (progress !== receiveProgressRef.current[transferKey]?.progress || isLast) {
                setReceiveProgress(prev => {
                    const current = prev[transferKey];
                    if (current && current.status === 'receiving') return { ...prev, [transferKey]: { ...current, progress: progress } };
                    return prev;
                });
            }

            if (isLast) {
                if (transferData.receivedBytes === transferData.totalSize) {
                    console.log(`All chunks received for ${transferData.name} from ${peerId}. Preparing download...`);
                    
                    const senderName = peerConnectionsRef.current[peerId]?.name ?? peerId;
                    
                    const isLargeFile = transferData.totalSize > 100 * 1024 * 1024;
                    
                    if (isLargeFile) {
                        const blob = new Blob(transferData.chunks, { type: transferData.fileType || 'application/octet-stream' });
                        const downloadUrl = URL.createObjectURL(blob);
                        
                        const link = document.createElement('a');
                        link.href = downloadUrl;
                        link.download = transferData.name;
                        link.style.display = 'none';
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        
                        setTimeout(() => {
                            URL.revokeObjectURL(downloadUrl);
                            delete fileChunksRef.current[transferKey];
                        }, 100);
                        
                        addChatMessage(`Downloaded large file: ${transferData.name} (${formatFileSize(transferData.totalSize)})`, 'system');
                    } else {
                        const blob = new Blob(transferData.chunks, { type: transferData.fileType || 'application/octet-stream' });
                        const newFile: ReceivedFile = { 
                            id: generateLocalId(), 
                            name: transferData.name, 
                            size: transferData.totalSize, 
                            blob: blob,
                            from: peerId, 
                            fromName: senderName, 
                            timestamp: Date.now() 
                        };
                        setReceivedFiles(prev => [...prev, newFile]);
                        delete fileChunksRef.current[transferKey];
                        addChatMessage(`Received file: ${transferData.name}`, 'system');
                    }
                    
                    setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], progress: 100, status: 'complete' } }));
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
      } else if (progressData?.status === 'pending') {
        console.log(`Ignoring chunk ${index} for pending file: ${transferKey}`);
      } else if (!progressData) {
        console.warn(`No progress data found for transfer: ${transferKey}. This might be a timing issue.`);
        if (transferData) {
          console.log(`Transfer data exists but progress is missing. Attempting to process chunk anyway.`);
          try {
            const byteString = atob(chunk);
            const byteArray = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) byteArray[i] = byteString.charCodeAt(i);

            transferData.chunks.push(byteArray);
            transferData.receivedBytes += byteArray.length;

            const progress = transferData.totalSize > 0 ? Math.round((transferData.receivedBytes / transferData.totalSize) * 100) : 0;
            
            setReceiveProgress(prev => {
              if (prev[transferKey]) {
                return { ...prev, [transferKey]: { ...prev[transferKey], progress, status: 'receiving' } };
              }
              return prev;
            });

            if (isLast && transferData.receivedBytes === transferData.totalSize) {
              console.log(`All chunks received (despite missing progress) for ${transferData.name}`);
              const senderName = peerConnectionsRef.current[peerId]?.name ?? peerId;
              const blob = new Blob(transferData.chunks, { type: transferData.fileType || 'application/octet-stream' });
              
              const isLargeFile = transferData.totalSize > 100 * 1024 * 1024;
              if (isLargeFile) {
                const downloadUrl = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = transferData.name;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                setTimeout(() => {
                  URL.revokeObjectURL(downloadUrl);
                  delete fileChunksRef.current[transferKey];
                }, 100);
                addChatMessage(`Downloaded large file: ${transferData.name} (${formatFileSize(transferData.totalSize)})`, 'system');
              } else {
                const newFile: ReceivedFile = { 
                  id: generateLocalId(), 
                  name: transferData.name, 
                  size: transferData.totalSize, 
                  blob: blob,
                  from: peerId, 
                  fromName: senderName, 
                  timestamp: Date.now() 
                };
                setReceivedFiles(prev => [...prev, newFile]);
                delete fileChunksRef.current[transferKey];
                addChatMessage(`Received file: ${transferData.name}`, 'system');
              }
              
              setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], progress: 100, status: 'complete' } }));
            }
          } catch (error) {
            console.error(`Error processing chunk without progress data:`, error);
          }
        }
      } else {
        console.warn(`Received chunk for unknown/completed transfer: ${transferKey}. Index: ${index}, Status: ${progressData?.status}`);
      }
    } else if (type === 'chunk-ack') {
      const { fileId, index } = message;
      console.log(`[ACK] Chunk ${index} acknowledged by ${peerId} for file ${fileId}`);
    } else if (type === 'file-accepted') {
      const { fileId, fileName } = message;
      const senderName = peerConnectionsRef.current[peerId]?.name || peerId;
      addChatMessage(`${senderName} accepted file: ${fileName}`, 'system');
      
      if (sendFileChunksRef.current) {
        sendFileChunksRef.current(fileId, peerId);
      }
    } else if (type === 'file-declined') {
      const { fileId, fileName } = message;
      const senderName = peerConnectionsRef.current[peerId]?.name || peerId;
      addChatMessage(`${senderName} declined file: ${fileName}`, 'system');
      const transferKey = `${fileId}_${peerId}`;
      setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'declined' } }));
    } else {
        console.warn(`Unknown data type received from peer ${peerId}: ${type}`);
    }
  }, [addChatMessage]);


  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
      setServerError(null);
    } else {
      setSelectedFile(null);
    }
  };

  const processDroppedFiles = useCallback((files: FileList | null | undefined) => {
      if (files && files.length > 0) {
          const file = files[0];
          
          const maxFileSize = 512 * 1024 * 1024 * 1024;
          if (file.size > maxFileSize) {
            setServerError("File too large. Maximum file size is 512GB.");
            return;
          }
          
          console.log("File received via drop/paste:", file.name, formatFileSize(file.size));
          setSelectedFile(file);
          setServerError(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
      }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const relatedTarget = e.relatedTarget as Node;
      if (!e.currentTarget.contains(relatedTarget)) {
          setIsDragging(false);
      }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      
      if (e.dataTransfer.items) {
          const items = Array.from(e.dataTransfer.items);
          for (const item of items) {
              if (item.kind === 'file') {
                  const entry = item.webkitGetAsEntry();
                  if (entry?.isDirectory) {
                      setServerError("Folder upload not supported yet. Please zip the folder first.");
                      return;
                  }
              }
          }
      }
      
      processDroppedFiles(e.dataTransfer.files);
  }, [processDroppedFiles]);

  useEffect(() => {
      const handlePaste = (event: ClipboardEvent) => {
          processDroppedFiles(event.clipboardData?.files);
      };
      document.addEventListener('paste', handlePaste);
      return () => {
          document.removeEventListener('paste', handlePaste);
      };
  }, [processDroppedFiles]);


  const sendFile = useCallback(async () => {
    if (!selectedFile) { setServerError("No file selected."); return; }
    
    const maxFileSize = 512 * 1024 * 1024 * 1024;
    if (selectedFile.size > maxFileSize) {
      setServerError("File too large. Maximum file size is 512GB.");
      return;
    }
    
    const connectedPeers = Object.values(peerConnectionsRef.current).filter(conn => conn.status === 'connected');
    if (connectedPeers.length === 0) { setServerError("No connected peers to send the file to."); return; }

    const fileId = generateLocalId();
    const fileName = selectedFile.name;
    const fileSize = selectedFile.size;
    const fileType = selectedFile.type;
    console.log(`Preparing to send file: ${fileName} (${formatFileSize(fileSize)}) to ${connectedPeers.length} peers.`);
    setServerError(null);

    const fileInfoMessage = JSON.stringify({ type: 'file-info', fileId, name: fileName, size: fileSize, fileType });

    fileChunksRef.current[`file_${fileId}`] = {
        file: selectedFile,
        fileId,
        fileName,
        fileSize,
        fileType,
        totalChunks: Math.ceil(fileSize / FILE_CHUNK_SIZE),
        acceptedPeers: new Set()
    };

    connectedPeers.forEach(conn => {
        const transferKey = `${fileId}_${conn.peerId}`;
        try {
            conn.peer.send(fileInfoMessage);
            setSendProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'pending', fileName, fileSize } }));
            console.log(`[Setup Send] Set progress status to 'pending' for ${transferKey}`);
        } catch (error) {
             console.error(`Failed to send file-info to ${conn.peerId}:`, error);
             setSendProgress(prev => ({ ...prev, [transferKey]: { progress: 0, status: 'failed', fileName, fileSize } }));
        }
    });
    
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    
    addChatMessage(`Waiting for peers to accept file: ${fileName}`, 'system');
  }, [selectedFile, addChatMessage]);

  const sendFileChunks = useCallback(async (fileId: string, peerId: string) => {
    const fileData = fileChunksRef.current[`file_${fileId}`];
    if (!fileData) {
      console.error(`File data not found for ${fileId}`);
      return;
    }
    
    const { file, fileName, fileSize } = fileData;
    const transferKey = `${fileId}_${peerId}`;
    const totalChunks = Math.ceil(fileSize / FILE_CHUNK_SIZE);
    
    console.log(`Waiting before sending chunks for ${fileName} to ${peerId}...`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    let retryCount = 0;
    let peerConn = peerConnectionsRef.current[peerId];
    
    while ((!peerConn || peerConn.status !== 'connected') && retryCount < 3) {
      console.log(`Peer ${peerId} not ready, retrying... (${retryCount + 1}/3)`);
      await new Promise(resolve => setTimeout(resolve, 500));
      peerConn = peerConnectionsRef.current[peerId];
      retryCount++;
    }
    
    if (!peerConn || peerConn.status !== 'connected') {
      console.error(`Peer ${peerId} not connected for file transfer after retries`);
      setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
      addChatMessage(`Failed to send file to ${peerConnectionsRef.current[peerId]?.name || peerId}: Connection lost`, 'system');
      return;
    }
    
    const dataChannel = (peerConn.peer as any)._channel;
    if (!dataChannel || dataChannel.readyState !== 'open') {
      console.log(`Data channel not ready, waiting...`);
      let channelRetries = 0;
      while (channelRetries < 10) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const currentChannel = (peerConnectionsRef.current[peerId]?.peer as any)?._channel;
        if (currentChannel && currentChannel.readyState === 'open') {
          console.log(`Data channel is now ready`);
          break;
        }
        channelRetries++;
      }
      
      const finalChannel = (peerConnectionsRef.current[peerId]?.peer as any)?._channel;
      if (!finalChannel || finalChannel.readyState !== 'open') {
        console.error(`Data channel still not ready after waiting`);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        addChatMessage(`Failed to send file to ${peerConnectionsRef.current[peerId]?.name || peerId}: Channel not ready`, 'system');
        return;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    let consecutiveSuccesses = 0;
    let sendDelay = 10;
    const minDelay = 0;
    const maxDelay = 50;
    
    setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'sending' } }));
    
    console.log(`Starting to send ${fileName} to ${peerId}. Total chunks: ${totalChunks}`);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * FILE_CHUNK_SIZE;
      const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      
      if (peerConnectionsRef.current[peerId]?.status !== 'connected') {
        console.error(`Peer ${peerId} disconnected during file transfer`);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        return;
      }
      
      const chunkBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          if (e.target?.result) {
            resolve(e.target.result as ArrayBuffer);
          } else {
            reject(new Error("Failed to read file chunk"));
          }
        };
        reader.onerror = () => reject(new Error("FileReader error"));
        reader.readAsArrayBuffer(chunk);
      }).catch(error => {
        console.error(`Error reading chunk ${i}:`, error);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        return null;
      });
      
      if (!chunkBuffer) return;
      
      let base64Chunk;
      try {
        const uint8Array = new Uint8Array(chunkBuffer);
        let binaryString = '';
        const encodeChunkSize = 16384;
        
        for (let j = 0; j < uint8Array.length; j += encodeChunkSize) {
          const subEnd = Math.min(j + encodeChunkSize, uint8Array.length);
          const subArray = uint8Array.subarray(j, subEnd);
          binaryString += String.fromCharCode.apply(null, Array.from(subArray));
        }
        
        base64Chunk = btoa(binaryString);
      } catch (error) {
        console.error(`Error encoding chunk ${i}:`, error);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        return;
      }
      
      const currentPeerConn = peerConnectionsRef.current[peerId];
      if (!currentPeerConn || currentPeerConn.status !== 'connected') {
        console.error(`Peer ${peerId} disconnected`);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        return;
      }
      
      const dataChannel = (currentPeerConn.peer as any)._channel;
      if (!dataChannel || dataChannel.readyState !== 'open') {
        console.error(`Data channel not ready for peer ${peerId}`);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        return;
      }
      
      const bufferAmount = dataChannel.bufferedAmount;
      const bufferThreshold = 768 * 1024;
      
      if (bufferAmount > bufferThreshold) {
        consecutiveSuccesses = 0;
        sendDelay = Math.min(sendDelay + 10, maxDelay);
        console.log(`Buffer high (${formatFileSize(bufferAmount)}), increasing delay to ${sendDelay}ms`);
        
        let waitCount = 0;
        while (dataChannel.bufferedAmount > bufferThreshold / 2 && waitCount < 30) {
          await new Promise(resolve => setTimeout(resolve, 10));
          waitCount++;
          
          if (peerConnectionsRef.current[peerId]?.status !== 'connected') {
            console.log(`Peer ${peerId} disconnected while waiting for buffer`);
            setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
            return;
          }
        }
      } else if (bufferAmount < bufferThreshold / 4) {
        consecutiveSuccesses++;
        if (consecutiveSuccesses > 2) {
          sendDelay = Math.max(sendDelay - 5, minDelay);
          if (i % 20 === 0) {
            console.log(`Buffer low (${formatFileSize(bufferAmount)}), decreasing delay to ${sendDelay}ms`);
          }
        }
      }
      
      const chunkMessage = JSON.stringify({
        type: 'file-chunk',
        fileId,
        chunk: base64Chunk,
        index: i,
        isLast: i === totalChunks - 1
      });
      
      const messageSize = new Blob([chunkMessage]).size;
      if (messageSize > 256 * 1024) {
        console.error(`Chunk ${i} message too large: ${formatFileSize(messageSize)}. Base64 encoding increased size too much.`);
        setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        addChatMessage(`File transfer failed: Chunk size too large after encoding`, 'system');
        return;
      }
      
      try {
        currentPeerConn.peer.send(chunkMessage);
        
        const progress = Math.round(((i + 1) / totalChunks) * 100);
        setSendProgress(prev => {
          const current = prev[transferKey];
          if (current && current.status === 'sending') {
            return { ...prev, [transferKey]: { ...current, progress } };
          }
          return prev;
        });
        
        if (i < totalChunks - 1 && sendDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, sendDelay));
        }
        
        if (i === totalChunks - 1) {
          console.log(`All chunks sent for ${fileName} to ${peerId}`);
          setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'complete' } }));
          addChatMessage(`Sent file: ${fileName} to ${peerConnectionsRef.current[peerId]?.name || peerId}`, 'system');
          
          fileData.acceptedPeers.add(peerId);
          
          const currentSendProgress = sendProgressRef.current;
          const allPendingTransfers = Object.keys(currentSendProgress).filter(key => key.startsWith(`${fileId}_`));
          const allComplete = allPendingTransfers.every(key => {
            const progress = currentSendProgress[key];
            return progress.status === 'complete' || progress.status === 'failed' || progress.status === 'declined';
          });
          
          if (allComplete) {
            delete fileChunksRef.current[`file_${fileId}`];
          }
        }
      } catch (error: any) {
        console.error(`Error sending chunk ${i} to ${peerId}:`, error);
        
        if (error.message && error.message.includes('Failure to send data')) {
          console.log(`Attempting to recover from send failure at chunk ${i}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const retryConn = peerConnectionsRef.current[peerId];
          const retryChannel = (retryConn?.peer as any)?._channel;
          
          if (retryConn?.status === 'connected' && retryChannel?.readyState === 'open') {
            try {
              console.log(`Retrying chunk ${i}`);
              retryConn.peer.send(chunkMessage);
            } catch (retryError) {
              console.error(`Retry failed for chunk ${i}:`, retryError);
              setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
              addChatMessage(`File transfer failed at ${Math.round((i / totalChunks) * 100)}%`, 'system');
              return;
            }
          } else {
            setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
            addChatMessage(`File transfer failed: Connection lost`, 'system');
            return;
          }
        } else {
          setSendProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
          addChatMessage(`File transfer failed: ${error.message || 'Unknown error'}`, 'system');
          return;
        }
      }
    }
  }, [addChatMessage]);

  useEffect(() => {
    sendFileChunksRef.current = sendFileChunks;
  }, [sendFileChunks]);

  const acceptFile = useCallback((transferKey: string) => {
    const progressData = receiveProgress[transferKey];
    if (!progressData || progressData.status !== 'pending') return;
    
    console.log(`Accepting file with transferKey: ${transferKey}`, progressData);
    
    fileChunksRef.current[transferKey] = { 
      chunks: [], 
      receivedBytes: 0, 
      totalSize: progressData.fileSize || 0, 
      name: progressData.fileName || 'unknown', 
      fileId: progressData.fileId, 
      fileType: progressData.fileType 
    };
    
    setReceiveProgress(prev => {
      const updated = { 
        ...prev, 
        [transferKey]: { ...prev[transferKey], status: 'receiving' as const } 
      };
      console.log(`Updated receive progress for ${transferKey} to 'receiving'`);
      receiveProgressRef.current = updated;
      return updated;
    });
    
    console.log(`File chunks initialized for ${transferKey}. Sending acceptance to sender...`);
    
    const senderId = progressData.peerId;
    if (!senderId) {
      console.error('No sender ID found for file acceptance');
      return;
    }
    
    const acceptMessage = JSON.stringify({ 
      type: 'file-accepted', 
      fileId: progressData.fileId, 
      fileName: progressData.fileName 
    });
    
    const senderConn = peerConnectionsRef.current[senderId];
    if (senderConn?.peer && senderConn.status === 'connected') {
      try {
        senderConn.peer.send(acceptMessage);
        console.log(`Sent acceptance for file ${progressData.fileName} to ${senderId}`);
      } catch (error) {
        console.error(`Failed to send file acceptance to ${senderId}:`, error);
        setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
        delete fileChunksRef.current[transferKey];
      }
    } else {
      console.error(`Peer ${senderId} not connected for file acceptance`);
      setReceiveProgress(prev => ({ ...prev, [transferKey]: { ...prev[transferKey], status: 'failed' } }));
      delete fileChunksRef.current[transferKey];
    }
    
    addChatMessage(`Accepting file: ${progressData.fileName}`, 'system');
  }, [receiveProgress, addChatMessage]);

  const declineFile = useCallback((transferKey: string) => {
    const progressData = receiveProgress[transferKey];
    if (!progressData || progressData.status !== 'pending') return;
    
    const senderId = progressData.peerId;
    if (!senderId) {
      console.error('No sender ID found for file decline');
      return;
    }
    
    const declineMessage = JSON.stringify({ 
      type: 'file-declined', 
      fileId: progressData.fileId, 
      fileName: progressData.fileName 
    });
    
    const senderConn = peerConnectionsRef.current[senderId];
    if (senderConn?.peer && senderConn.status === 'connected') {
      try {
        senderConn.peer.send(declineMessage);
      } catch (error) {
        console.error(`Failed to send file decline to ${senderId}:`, error);
      }
    }
    
    setReceiveProgress(prev => {
      const newProgress = { ...prev };
      delete newProgress[transferKey];
      return newProgress;
    });
    
    addChatMessage(`Declined file: ${progressData.fileName}`, 'system');
  }, [receiveProgress, addChatMessage]);

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

  const sendChatMessage = useCallback(() => {
    if (!messageInput.trim()) return;
    const messageText = messageInput.trim();
    addChatMessage(messageText, 'me');

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
  }, [messageInput, addChatMessage]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const copyShareLink = useCallback(() => {
    if (!shareLink) return;
    navigator.clipboard.writeText(shareLink)
      .then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); })
      .catch(err => console.error('Failed to copy link:', err));
  }, [shareLink]);

  const connectedPeerCount = Object.values(peerConnections).filter(p => p.status === 'connected').length;
  const connectingPeerCount = Object.values(peerConnections).filter(p => p.status === 'connecting').length;

  return (
    <div
        className="relative p-4 md:p-6 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 min-h-screen transition-colors duration-300 flex flex-col md:flex-row gap-6"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
    >
        {isDragging && (
            <div className="absolute inset-0 bg-blue-500/30 dark:bg-blue-800/30 border-4 border-dashed border-blue-600 dark:border-blue-400 rounded-lg flex items-center justify-center pointer-events-none z-50">
                <p className="text-2xl font-semibold text-blue-800 dark:text-blue-200">Drop file here</p>
            </div>
        )}

        <div className="w-full md:w-1/3 lg:w-1/4 flex flex-col gap-4">
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

                {!isNameSet && (
                    <div className="mb-3 p-3 bg-red-600 dark:bg-red-700 rounded-md flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-white flex-shrink-0" />
                        <p className="text-sm text-white">Please enter a name to start sharing files and connecting to peers</p>
                    </div>
                )}

                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">Your ID:</p>
                 <code className="text-sm px-2 py-1 bg-neutral-200 dark:bg-neutral-700 rounded font-mono break-all block mb-3">{userId || 'Connecting...'}</code>

                 <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">Share Link:</p>
                 <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                     <input
                        type="text" readOnly value={shareLink || 'Generating...'}
                        className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 text-xs focus:outline-none truncate w-full"
                        onClick={(e) => isNameSet && (e.target as HTMLInputElement).select()}
                        disabled={!shareLink || !isNameSet}
                    />
                     <button onClick={copyShareLink} disabled={!shareLink || linkCopied || !isNameSet} title={!isNameSet ? "Set your name first" : "Copy share link"}
                        className="p-2 bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600 rounded disabled:opacity-50 self-center sm:self-auto">
                        {linkCopied ? <Check className="w-4 h-4 text-green-600 dark:text-green-400" /> : <LinkIcon className="w-4 h-4" />}
                     </button>
                 </div>
                 {serverError && ( <p className="mt-3 text-xs text-red-600 dark:text-red-400 flex items-center gap-1"> <AlertCircle className="w-3 h-3" /> {serverError} </p> )}
            </div>

            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Connect to Peer</h2>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <input type="text" placeholder="Enter Peer ID" value={peerIdInput} onChange={(e) => setPeerIdInput(e.target.value)}
                        className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm dark:placeholder-neutral-400 w-full"
                        disabled={!socketConnected || !!isConnectingPeer || !isNameSet}
                        onKeyPress={(e) => e.key === 'Enter' && isNameSet && !isConnectingPeer && peerIdInput && requestPeerConnection(peerIdInput)}
                    />
                    <button onClick={() => requestPeerConnection(peerIdInput)}
                        disabled={!socketConnected || !peerIdInput || !!isConnectingPeer || !!peerConnections[peerIdInput] || !isNameSet}
                        className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center w-full sm:w-[80px]">
                        {isConnectingPeer === peerIdInput ? <Loader2 className="w-4 h-4 animate-spin" /> : "Connect"}
                    </button>
                </div>
            </div>

            {Object.keys(incomingRequests).length > 0 && (
                <div className="p-4 border border-yellow-400 dark:border-yellow-600 rounded-md bg-yellow-50 dark:bg-yellow-900/30">
                    <h2 className="text-lg font-semibold mb-2 text-yellow-800 dark:text-yellow-300">Incoming Requests</h2>
                    <ul className="space-y-2">
                        {Object.values(incomingRequests).map(({ peerId }) => (
                            <li key={peerId} className="flex items-center justify-between text-sm p-1.5 bg-white dark:bg-neutral-700 rounded shadow-sm">
                                <span className="font-medium truncate" title={peerId}>{peerConnections[peerId]?.name || peerId}</span>
                                <div className="flex gap-2">
                                    <button onClick={() => handleAcceptRequest(peerId)} title="Accept" className="p-1 text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 rounded hover:bg-green-100 dark:hover:bg-green-800"> <Check className="w-4 h-4" /> </button>
                                    <button onClick={() => handleDeclineRequest(peerId)} title="Decline" className="p-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 rounded hover:bg-red-100 dark:hover:bg-red-800"> <X className="w-4 h-4" /> </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

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

        <div className="w-full md:w-2/3 lg:w-3/4 flex flex-col gap-4">
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                 <h2 className="text-lg font-semibold mb-3">File Transfer</h2>
                 <div className="flex flex-col sm:flex-row items-center gap-3 mb-4">
                     <label className={`px-4 py-2 rounded border border-neutral-300 dark:border-neutral-600 cursor-pointer flex items-center gap-2 text-sm ${selectedFile ? 'bg-neutral-100 dark:bg-neutral-700' : 'bg-white dark:bg-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-500'}`}>
                         <Paperclip className="w-4 h-4" /> <span>{selectedFile ? "Change File" : "Choose File"}</span>
                         <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" disabled={connectedPeerCount === 0 && !selectedFile} />
                     </label>
                     {selectedFile && ( <span className="text-sm text-neutral-700 dark:text-neutral-300 truncate max-w-[200px]" title={selectedFile.name}> {selectedFile.name} ({formatFileSize(selectedFile.size)}) </span> )}
                     {!selectedFile && <span className="text-sm text-neutral-500 dark:text-neutral-400">No file chosen</span>}
                    <button onClick={sendFile} disabled={!selectedFile || connectedPeerCount === 0 || Object.values(sendProgress).some(p => p.status === 'sending')}
                        className="ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"> <Send className="w-4 h-4" /> Send </button>
                 </div>

                 {(Object.keys(sendProgress).length > 0 || Object.keys(receiveProgress).length > 0) && (
                     <div className="mt-4 space-y-3 text-xs">
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
                         {Object.entries(receiveProgress).filter(([key, p]) => p.status !== 'complete' || p.progress < 100).map(([key, progressData]) => {
                              const { progress, status, fileName, fileSize } = progressData;
                              const peerId = key.split('_')[0];
                              
                              if (status === 'pending') {
                                  return (
                                      <div key={key} className="border border-blue-300 dark:border-blue-600 rounded p-3 bg-blue-50 dark:bg-blue-900/20">
                                          <div className="flex justify-between items-center mb-2">
                                              <span className="font-medium truncate pr-2" title={fileName}>
                                                  <Download className="w-3 h-3 inline mr-1" /> 
                                                  Incoming from {peerId}: {fileName} ({formatFileSize(fileSize ?? 0)})
                                              </span>
                                              <span className="font-mono text-blue-600 dark:text-blue-400">Pending</span>
                                          </div>
                                          <div className="flex gap-2 mt-2">
                                              <button 
                                                  onClick={() => acceptFile(key)}
                                                  className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs flex items-center gap-1"
                                              >
                                                  <Download className="w-3 h-3" /> Accept
                                              </button>
                                              <button 
                                                  onClick={() => declineFile(key)}
                                                  className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs flex items-center gap-1"
                                              >
                                                  <X className="w-3 h-3" /> Decline
                                              </button>
                                          </div>
                                      </div>
                                  );
                              }
                              
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
                                    </div>
                                </div>
                            ))}
                            {connectedPeerCount === 0 && chatMessages.length === 0 && ( <p className="text-xs text-center text-neutral-500 dark:text-neutral-400 italic py-4">Connect to a peer to start chatting.</p> )}
                            {chatMessages.length === 0 && connectedPeerCount > 0 && ( <p className="text-xs text-center text-neutral-500 dark:text-neutral-400 italic py-4">Chat history is empty. Send a message!</p> )}
                        </div>
                        <div className="flex items-center gap-2 pt-2 border-t border-neutral-300 dark:border-neutral-700">
                            <input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()} placeholder={connectedPeerCount > 0 ? "Type your message..." : "Connect to a peer to chat"}
                                className="flex-grow px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm dark:placeholder-neutral-400"
                                disabled={connectedPeerCount === 0 || !isNameSet}
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