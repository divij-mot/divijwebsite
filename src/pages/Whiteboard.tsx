// --- START OF FILE  @/src/pages/Whiteboard.tsx ---
/* eslint‑disable @typescript-eslint/no‑explic it‑any */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  MouseEvent,
  ReactNode
} from 'react';
import Peer from 'simple-peer/simplepeer.min.js';
import type { Instance as PeerInstance } from 'simple-peer';
import {
  Pencil,
  Eraser,
  Square,
  Circle,
  LineChart,
  Type,
  RotateCcw,
  RotateCw,
  Trash2,
  Download,
  UploadCloud,
  Users,
  Link as LinkIcon,
  Copy,
  Check,
  X
} from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

// ─── Types ────────────────────────────────────────────────────────────────────
type Tool =
  | 'pen'
  | 'highlighter'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'text'
  | 'eraser';

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  id: string;
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
  text?: string;
}

interface PeerConnection {
  peerId: string;
  peer: PeerInstance | null;
  status:
    | 'connecting'
    | 'connected'
    | 'failed'
    | 'disconnected'
    | 'pending_approval';
  name?: string;
}

// ─── Whiteboard Constants ────────────────────────────────────────────────────
const BOARD_WIDTH = 3840; // Logical width of the drawing area (Increased)
const BOARD_HEIGHT = 2160; // Logical height (Increased)
const MIN_ZOOM = 0.1; // Minimum zoom level
const MAX_ZOOM = 5; // Maximum zoom level
const PAN_MARGIN = 50; // Minimum pixels of the board to keep visible when panning

// ─── Environment constants (shared with Share.tsx) ───────────────────────────
const API_BASE_URL =
  process.env.NODE_ENV === 'development'
    ? 'http://localhost:8000'
    : BACKEND_URL;

const SIGNALING_SERVER_URL =
  process.env.NODE_ENV === 'development'
    ? 'ws://localhost:8000'
    : `wss://${BACKEND_URL.replace('https://', '')}`; // Updated to use BACKEND_URL

// ─── Helper utilities ────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);

const downloadBlob = (blob: Blob, fileName: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

// ─── Component ───────────────────────────────────────────────────────────────
const Whiteboard: React.FC = () => {
  // ─── Canvas refs ───────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  // View‑transform (zoom / pan)
  const scaleRef = useRef<number>(1);
  // Adjust initial pan to center the board roughly (can be refined)
  const panRef = useRef<Point>({ x: 50, y: 50 });
  const isPanning = useRef<boolean>(false);

  // Function to clamp pan based on current scale and canvas size
  const clampPan = useCallback((newPan: Point, currentScale: number, canvas: HTMLCanvasElement | null): Point => {
      if (!canvas) return newPan;
      const { clientWidth: cw, clientHeight: ch } = canvas;

      // Calculate min/max pan values to keep the board edges within PAN_MARGIN of the screen edges
      const minPanX = PAN_MARGIN - BOARD_WIDTH * currentScale;
      const maxPanX = cw - PAN_MARGIN;
      const minPanY = PAN_MARGIN - BOARD_HEIGHT * currentScale;
      const maxPanY = ch - PAN_MARGIN;

      // If the board is smaller than the viewport, center it instead of clamping to edges
      const clampedX = BOARD_WIDTH * currentScale < cw - 2 * PAN_MARGIN
          ? (cw - BOARD_WIDTH * currentScale) / 2 // Center horizontally
          : clamp(newPan.x, minPanX, maxPanX);

      const clampedY = BOARD_HEIGHT * currentScale < ch - 2 * PAN_MARGIN
          ? (ch - BOARD_HEIGHT * currentScale) / 2 // Center vertically
          : clamp(newPan.y, minPanY, maxPanY);

      return { x: clampedX, y: clampedY };
  }, []);


  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = canvas;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctxRef.current = ctx;
    // Clamp pan after resize and redraw
    panRef.current = clampPan(panRef.current, scaleRef.current, canvasRef.current);
    redrawAll(); // re‑paint after resize
  }, [clampPan]); // Add clampPan dependency

  // ─── Whiteboard state ──────────────────────────────────────────────────────
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);

  const [undoStack, setUndoStack] = useState<Stroke[][]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[][]>([]);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#000000');
  const [width, setWidth] = useState<number>(2);

  const [textInputPos, setTextInputPos] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState<string>('');

  // ─── Drawing helpers ───────────────────────────────────────────────────────
  const boardToScreen = (p: Point): Point => ({
    x: p.x * scaleRef.current + panRef.current.x,
    y: p.y * scaleRef.current + panRef.current.y
  });

  const screenToBoard = (p: Point): Point => ({
    x: (p.x - panRef.current.x) / scaleRef.current,
    y: (p.y - panRef.current.y) / scaleRef.current
  });

  // Helper to clamp a point to the board boundaries
  const clampToBoard = (p: Point): Point => ({
      x: clamp(p.x, 0, BOARD_WIDTH),
      y: clamp(p.y, 0, BOARD_HEIGHT)
  });


  const drawStroke = useCallback((s: Stroke, ctx?: CanvasRenderingContext2D) => {
    const context = ctx ?? ctxRef.current;
    if (!context) return;

    context.save();
    context.translate(panRef.current.x, panRef.current.y);
    context.scale(scaleRef.current, scaleRef.current);

    if (s.tool === 'highlighter') {
      context.globalAlpha = 0.25;
    }
    if (s.tool === 'eraser') {
      context.globalCompositeOperation = 'destination-out';
    } else {
      context.globalCompositeOperation = 'source-over';
    }

    context.strokeStyle = s.color;
    context.fillStyle = s.color;
    context.lineWidth = s.width;

    if (s.tool === 'rect' || s.tool === 'ellipse' || s.tool === 'line') {
      const [p1, p2] = s.points;
      if (!p1 || !p2) return;

      const w = p2.x - p1.x;
      const h = p2.y - p1.y;

      if (s.tool === 'rect') {
        context.strokeRect(p1.x, p1.y, w, h);
      } else if (s.tool === 'ellipse') {
        context.beginPath();
        context.ellipse(
          p1.x + w / 2,
          p1.y + h / 2,
          Math.abs(w / 2),
          Math.abs(h / 2),
          0,
          0,
          Math.PI * 2
        );
        context.stroke();
      } else {
        context.beginPath();
        context.moveTo(p1.x, p1.y);
        context.lineTo(p2.x, p2.y);
        context.stroke();
      }
    } else if (s.tool === 'text' && s.text) {
      context.font = `${16 + s.width * 2}px sans-serif`;
      context.fillText(s.text, s.points[0].x, s.points[0].y);
    } else {
      context.beginPath();
      s.points.forEach((p, idx) => {
        if (idx === 0) context.moveTo(p.x, p.y);
        else context.lineTo(p.x, p.y);
      });
      context.stroke();
    }
    context.restore();
  }, []);

  const redrawAll = useCallback(() => {
    // Get canvas and context once
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!ctx || !canvas) return;

    // Clear canvas and set white background
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    ctx.fillStyle = '#FFFFFF'; // Set fill to white
    ctx.fillRect(0, 0, canvas.width, canvas.height); // Fill the entire canvas
    // ctx.clearRect(0, 0, canvas.width, canvas.height); // ClearRect is no longer needed as fillRect overwrites
    ctx.restore(); // Restore previous transform state (like dpr scaling)

    // Draw board boundary (visual aid)
    ctx.save();
    ctx.translate(panRef.current.x, panRef.current.y);
    ctx.scale(scaleRef.current, scaleRef.current);
    ctx.strokeStyle = 'rgba(150, 150, 150, 0.2)'; // Light grey, semi-transparent
    ctx.lineWidth = 1 / scaleRef.current; // Keep line width consistent regardless of zoom
    ctx.strokeRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    ctx.restore();

    // Draw all strokes
    strokesRef.current.forEach(s => drawStroke(s, ctx));
  }, [drawStroke]); // Removed clampPan dependency as it's not used here


  // ─── Pointer events ────────────────────────────────────────────────────────
  const drawing = useRef<Stroke | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (tool !== 'text' && e.shiftKey)) {
      // middle‑click or shift+drag → pan
      isPanning.current = true;
      return;
    }

    if (tool === 'text') {
      setTextInputPos(screenToBoard({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }));
      return;
    }

    // Calculate the initial point in board coordinates
    const startBoardPos = screenToBoard({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY });

    // Check if the starting point is within the defined board area
    if (startBoardPos.x < 0 || startBoardPos.x > BOARD_WIDTH || startBoardPos.y < 0 || startBoardPos.y > BOARD_HEIGHT) {
        // If starting outside the bounds, do nothing
        drawing.current = null;
        return;
    }

    // If starting point is valid, create the new stroke (no need to clamp start point now)
    const newStroke: Stroke = {
      id: uuid(),
      tool,
      color,
      width,
      points: [startBoardPos] // Use the original, valid starting point
    };

    // Set the current drawing and add to strokes state
    drawing.current = newStroke;
    setStrokes(prev => [...prev, newStroke]);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPanning.current) {
      const newPan = {
          x: panRef.current.x + e.movementX,
          y: panRef.current.y + e.movementY
      };
      // Clamp the new pan position
      panRef.current = clampPan(newPan, scaleRef.current, canvasRef.current);
      redrawAll();
      return;
    }

    if (!drawing.current) return;
    // Clamp the current point to the board
    const boardPos = clampToBoard(screenToBoard({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }));

    // Check if the new point is different from the last one to avoid unnecessary updates/duplicates
    const lastPoint = drawing.current.points[drawing.current.points.length - 1];
    if (lastPoint && lastPoint.x === boardPos.x && lastPoint.y === boardPos.y) {
        return; // Don't add identical points
    }

    if (['rect', 'ellipse', 'line'].includes(tool)) {
      // Update second point (always keep 2 points for shapes/lines)
      drawing.current.points[1] = boardPos;
    } else {
      // Add the clamped point for freehand tools
      drawing.current.points.push(boardPos);
    }
    redrawAll();
    drawStroke(drawing.current); // Draw the updated stroke preview
  };

  const finishStroke = () => {
    if (isPanning.current) {
      isPanning.current = false;
      return;
    }
    if (!drawing.current) return;
    broadcast({ type: 'stroke', stroke: drawing.current });
    setUndoStack(prev => [...prev, strokesRef.current]);
    drawing.current = null;
  };

  // ─── Mouse wheel zoom ──────────────────────────────────────────────────────
  const handleWheel = (e: React.WheelEvent) => {
    // Always prevent default browser scroll/zoom behavior when wheel is used over canvas
    e.preventDefault(); // Prevent default page scroll/zoom when scrolling on canvas

    // Remove the Ctrl key check to allow canvas zoom without it
    // if (!e.ctrlKey) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomAroundBoard = screenToBoard({ x: mouseX, y: mouseY });

    const factor = e.deltaY < 0 ? 1.1 : 0.9; // Zoom factor
    const newScale = clamp(scaleRef.current * factor, MIN_ZOOM, MAX_ZOOM); // Use defined min/max zoom

    // Calculate the new pan position to keep the zoom centered on the mouse pointer
    const newPanX = mouseX - zoomAroundBoard.x * newScale;
    const newPanY = mouseY - zoomAroundBoard.y * newScale;

    // Update scale and pan, clamping the pan
    scaleRef.current = newScale;
    panRef.current = clampPan({ x: newPanX, y: newPanY }, newScale, canvas);

    redrawAll();
  };

  // ─── Text tool helper ──────────────────────────────────────────────────────
  const confirmText = () => {
    if (!textInputPos || !textValue.trim()) {
      setTextInputPos(null);
      setTextInputPos(null); // Clear position if text is empty
      setTextValue('');
      return;
    }
    // Clamp the text position before creating the stroke
    const clampedPos = clampToBoard(textInputPos);

    const s: Stroke = {
      id: uuid(),
      tool: 'text',
      color,
      width,
      points: [clampedPos], // Use clamped position
      text: textValue.trim()
    };
    setStrokes(prev => [...prev, s]);
    broadcast({ type: 'stroke', stroke: s });
    setUndoStack(prev => [...prev, strokesRef.current]);
    setTextInputPos(null);
    setTextValue('');
  };

  // ─── Undo / redo ───────────────────────────────────────────────────────────
  const undo = () => {
    if (!undoStack.length) return;
    setRedoStack(prev => [...prev, strokesRef.current]);
    setStrokes(undoStack[undoStack.length - 1]);
    setUndoStack(stack => stack.slice(0, -1));
  };

  const redo = () => {
    if (!redoStack.length) return;
    setUndoStack(prev => [...prev, strokesRef.current]);
    setStrokes(redoStack[redoStack.length - 1]);
    setRedoStack(stack => stack.slice(0, -1));
  };

  // Keep canvas updated when strokes change
  useEffect(redrawAll, [strokes, redrawAll]);

  // ─── Export / import helpers ───────────────────────────────────────────────
  const exportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      downloadBlob(blob, `whiteboard-${Date.now()}.png`);
    });
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(strokesRef.current)], {
      type: 'application/json'
    });
    downloadBlob(blob, `whiteboard-${Date.now()}.wb.json`);
  };

  const importJSON = (file: File) => {
    file.text().then(text => {
      try {
        const imported: Stroke[] = JSON.parse(text);
        if (!Array.isArray(imported)) throw new Error();
        setStrokes(imported);
        broadcast({ type: 'full-state', strokes: imported });
      } catch {
        alert('Invalid whiteboard file');
      }
    });
  };

  // ─── Collaborative logic ───────────────────────────────────────────────────
  const userIdRef = useRef<string>('');
  const [userName, setUserName] = useState<string>('');
  const userNameRef = useRef<string>('');
  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);

  const [peerConnections, setPeerConnections] = useState<
    Record<string, PeerConnection>
  >({});
  const peerConnectionsRef = useRef<typeof peerConnections>({});
  useEffect(() => {
    peerConnectionsRef.current = peerConnections;
  }, [peerConnections]);

  const [shareLink, setShareLink] = useState<string>('');
  const [linkCopied, setLinkCopied] = useState<boolean>(false);
  const [joinCode, setJoinCode] = useState<string>('');
  const [incoming, setIncoming] = useState<{ peerId: string; name?: string }[]>(
    []
  );

  const socketRef = useRef<WebSocket | null>(null);
  const sendQueue = useRef<any[]>([]);

  // ─── Minimal signalling (same protocol as Share.tsx) ───────────────────────
  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      // 1. unique ID
      const res = await fetch(`${API_BASE_URL}/generate-id`);
      const { id: myId } = (await res.json()) as { id: string };
      if (!isMounted) return;
      userIdRef.current = myId;

      const baseUrl = `${window.location.origin}${window.location.pathname}`;
      setShareLink(`${baseUrl}?peer=${myId}`);

      // 2. open websocket
      const ws = new WebSocket(`${SIGNALING_SERVER_URL}/ws/${myId}`);
      socketRef.current = ws;

      ws.onopen = () => {
        sendQueue.current.forEach(p => ws.send(JSON.stringify(p)));
        sendQueue.current.length = 0;

        // auto‑connect if ?peer=…
        const peerParam = new URLSearchParams(location.search).get('peer');
        if (peerParam) requestPeerConnection(peerParam);
      };

      ws.onmessage = ev => {
        const message = JSON.parse(ev.data);
        handleSignalingMessage(message);
      };
    };

    init();
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    return () => {
      isMounted = false;
      window.removeEventListener('resize', resizeCanvas);
      socketRef.current?.close();
      // Object.values(peerConnectionsRef.current).forEach(p => p.peer?.destroy()); // Commented out: Let browser handle peer cleanup on socket close/unmount? See if this prevents premature disconnects.
    };
  }, [resizeCanvas]);

  // ─── Signalling helpers ────────────────────────────────────────────────────
  const sendToServer = (payload: any) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    } else {
      sendQueue.current.push(payload);
    }
  };

  const requestPeerConnection = (targetId: string) => {
    if (!targetId || targetId === userIdRef.current) return;
    setPeerConnections(prev => ({
      ...prev,
      [targetId]: {
        peerId: targetId,
        peer: null,
        status: 'connecting'
      }
    }));
    sendToServer({
      type: 'connection-request',
      peerId: targetId,
      name: userNameRef.current
    });
  };

  const createPeer = (
    peerId: string,
    initiator: boolean,
    offerData?: any
  ): PeerInstance => {
    const peer = new Peer({
      initiator,
      trickle: true,
      config: { // Add STUN server configuration
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          // You could add more STUN servers or TURN servers here if needed
        ]
      }
    });

    peer.on('signal', (data: any) => { // Add type 'any' for signal data
        // Determine message type based on signal data
        const messageType = data.type === 'offer' ? 'offer' : data.type === 'answer' ? 'answer' : 'ice-candidate';
        const payloadKey = messageType === 'ice-candidate' ? 'candidate' : messageType;

        // Ensure the target field is always included
        sendToServer({
            type: messageType,
            target: peerId, // Explicitly set the target peer ID
            [payloadKey]: data
        });
    });


    peer.on('connect', () => {
      setPeerConnections(prev => ({
        ...prev,
        [peerId]: { ...prev[peerId], status: 'connected', peer }
      }));
      // Send full state to the new peer
      peer.send(JSON.stringify({ type: 'full-state', strokes: strokesRef.current }));

      // Send list of other connected peers to the new peer
      const otherPeerIds = Object.keys(peerConnectionsRef.current).filter(
          id => id !== peerId && peerConnectionsRef.current[id]?.status === 'connected'
      );
      if (otherPeerIds.length > 0) {
          peer.send(JSON.stringify({ type: 'peer-list', peers: otherPeerIds }));
      }
      // Also send own user info (if name is set)
      if (userNameRef.current) {
          peer.send(JSON.stringify({ type: 'user-info', name: userNameRef.current, userId: userIdRef.current }));
      }
    });

    peer.on('data', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        handlePeerData(msg, peerId);
      } catch {
        console.error('Invalid peer data');
      }
    });

    peer.on('close', () => {
      setPeerConnections(prev => {
        const { [peerId]: _, ...rest } = prev;
        return rest;
      });
    });

    peer.on('error', err => {
      console.error(err);
      setPeerConnections(prev => ({
        ...prev,
        [peerId]: { ...prev[peerId], status: 'failed' }
      }));
    });

    if (offerData) peer.signal(offerData);
    return peer;
  };

  const handleSignalingMessage = (msg: any) => {
    const { type, peerId, source, offer, answer, candidate } = msg;
    switch (type) {
      case 'connection-request':
        setIncoming(prev => [...prev, { peerId, name: msg.name }]);
        setPeerConnections(prev => ({
          ...prev,
          [peerId]: {
            peerId,
            peer: null,
            status: 'pending_approval',
            name: msg.name
          }
        }));
        break;

      case 'offer': {
        const target = source;
        let p = peerConnectionsRef.current[target]?.peer;
        if (!p) {
          p = createPeer(target, false);
          setPeerConnections(prev => ({
            ...prev,
            [target]: { ...prev[target], peer: p, status: 'connecting' }
          }));
        }
        p.signal(offer);
        break;
      }

      case 'answer': {
        const t = source;
        peerConnectionsRef.current[t]?.peer?.signal(answer);
        break;
      }

      case 'ice-candidate': {
        const t = source;
        peerConnectionsRef.current[t]?.peer?.signal(candidate);
        break;
      }

      case 'connection-success':
        if (!peerConnectionsRef.current[peerId]?.peer) {
          const p = createPeer(peerId, true);
          setPeerConnections(prev => ({
            ...prev,
            [peerId]: { ...prev[peerId], peer: p, status: 'connecting' }
          }));
        }
        break;

      case 'connection-declined':
        setPeerConnections(prev => {
          const { [peerId]: _, ...rest } = prev;
          return rest;
        });
        break;

      case 'peer-disconnected':
        setPeerConnections(prev => {
          const { [peerId]: _, ...rest } = prev;
          return rest;
        });
        break;

      default:
        break;
    }
  };

  // ─── P2P data handling ─────────────────────────────────────────────────────
  const broadcast = (payload: any) => {
    Object.values(peerConnectionsRef.current).forEach(pc => {
      if (pc.status === 'connected' && pc.peer?.connected) {
        try {
          pc.peer.send(JSON.stringify(payload));
        } catch {
          /* ignore */
        }
      }
    });
  };

  const handlePeerData = (msg: any, sourcePeerId: string) => { // Renamed peerId to sourcePeerId for clarity
    // console.log(`Received data from ${sourcePeerId}:`, msg.type); // Optional: log received data type and source
    switch (msg.type) {
      case 'stroke':
        // Avoid adding duplicate strokes if received from multiple peers?
        // Basic check: don't add if stroke ID already exists
        if (!strokesRef.current.some(s => s.id === msg.stroke?.id)) {
            setStrokes(prev => [...prev, msg.stroke]);
        }
        break;
      case 'clear':
        setStrokes([]);
        break;
      case 'full-state':
        // Maybe merge states carefully instead of overwriting? For now, overwrite.
        setStrokes(msg.strokes || []);
        break;
      case 'peer-list': // Handle receiving list of peers
        console.log(`Received peer list from ${sourcePeerId}:`, msg.peers);
        msg.peers?.forEach((idToConnect: string) => {
          if (idToConnect !== userIdRef.current && !peerConnectionsRef.current[idToConnect]) {
            console.log(`Connecting to peer from received list: ${idToConnect}`);
            requestPeerConnection(idToConnect); // Initiate connection
          }
        });
        break;
      case 'user-info': // Handle receiving user info
         console.log(`Received user info from ${sourcePeerId}:`, msg.name);
         setPeerConnections(prev => prev[sourcePeerId] ? { ...prev, [sourcePeerId]: { ...prev[sourcePeerId], name: msg.name } } : prev);
         // Update incoming request name if applicable
         setIncoming(prev => prev.map(req => req.peerId === sourcePeerId ? { ...req, name: msg.name } : req));
         break;
      default:
        console.warn(`Unknown peer data type from ${sourcePeerId}: ${msg.type}`);
        break;
    }
  };

  // ─── Clear board ───────────────────────────────────────────────────────────
  const clearBoard = () => {
    if (!confirm('Clear entire board?')) return;
    setStrokes([]);
    broadcast({ type: 'clear' });
  };

  // ─── JSX helpers ───────────────────────────────────────────────────────────
  const ToolButton = ({
    active,
    onClick,
    children,
    title
  }: {
    active: boolean;
    onClick: () => void;
    children: ReactNode;
    title?: string;
  }) => (
    <button
      className={`p-2 rounded-lg border ${
        active
          ? 'bg-blue-500 text-white border-blue-500'
          : 'border-neutral-500 dark:border-neutral-700'
      }`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );

  const copyLink = () => {
    if (!shareLink) return;
    navigator.clipboard
      .writeText(shareLink)
      .then(() => {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      })
      .catch(console.error);
  };

  // Add useEffect for manual wheel listener attachment to prevent passive listener warning
  useEffect(() => {
    const canvas = canvasRef.current;
    // The handleWheel function needs to be stable or included in dependencies
    // Need to cast WheelEvent to React.WheelEvent for the handler function type
    const wheelHandler = (e: WheelEvent) => handleWheel(e as unknown as React.WheelEvent<HTMLCanvasElement>);

    if (canvas) {
        // Attach the wheel listener with passive: false
        canvas.addEventListener('wheel', wheelHandler, { passive: false });
        console.log("Attached non-passive wheel listener"); // Debug log

        // Cleanup function to remove the listener
        return () => {
            canvas.removeEventListener('wheel', wheelHandler);
            console.log("Removed wheel listener"); // Debug log
        };
    }
  }, [handleWheel]); // Re-run if handleWheel function identity changes


  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      {/* Top toolbar */}
      <div className="flex flex-wrap gap-2 p-2 border-b border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900">
        {/* Tools */}
        <ToolButton active={tool === 'pen'} onClick={() => setTool('pen')} title="Pen">
          <Pencil size={18} />
        </ToolButton>
        <ToolButton
          active={tool === 'highlighter'}
          onClick={() => setTool('highlighter')}
          title="Highlighter"
        >
          <Pencil className="opacity-50" size={18} />
        </ToolButton>
        <ToolButton active={tool === 'eraser'} onClick={() => setTool('eraser')} title="Eraser">
          <Eraser size={18} />
        </ToolButton>
        <ToolButton active={tool === 'rect'} onClick={() => setTool('rect')} title="Rectangle">
          <Square size={18} />
        </ToolButton>
        <ToolButton active={tool === 'ellipse'} onClick={() => setTool('ellipse')} title="Ellipse">
          <Circle size={18} />
        </ToolButton>
        <ToolButton active={tool === 'line'} onClick={() => setTool('line')} title="Line">
          <LineChart size={18} />
        </ToolButton>
        <ToolButton active={tool === 'text'} onClick={() => setTool('text')} title="Text">
          <Type size={18} />
        </ToolButton>

        {/* Divider */}
        <span className="w-px h-6 bg-neutral-400 mx-1" />

        {/* Colour & size */}
        <input
          type="color"
          value={color}
          onChange={e => setColor(e.target.value)}
          className="w-8 h-8 p-0 border border-neutral-400 rounded"
          title="Stroke colour"
        />
        <input
          type="range"
          min={1}
          max={20}
          value={width}
          onChange={e => setWidth(+e.target.value)}
          title="Stroke width"
        />

        {/* Divider */}
        <span className="w-px h-6 bg-neutral-400 mx-1" />

        {/* Undo / redo / clear */}
        <ToolButton active={false} onClick={undo} title="Undo">
          <RotateCcw size={18} />
        </ToolButton>
        <ToolButton active={false} onClick={redo} title="Redo">
          <RotateCw size={18} />
        </ToolButton>
        <ToolButton active={false} onClick={clearBoard} title="Clear">
          <Trash2 size={18} />
        </ToolButton>

        {/* Divider */}
        <span className="w-px h-6 bg-neutral-400 mx-1" />

        {/* Import / export */}
        <ToolButton active={false} onClick={exportPNG} title="Download PNG">
          <Download size={18} />
        </ToolButton>
        <ToolButton active={false} onClick={exportJSON} title="Download .wb">
          <Download size={18} className="rotate-90" />
        </ToolButton>
        <label className="p-2 rounded-lg border border-neutral-500 dark:border-neutral-700 cursor-pointer">
          <UploadCloud size={18} />
          <input
            type="file"
            accept=".wb.json,application/json"
            className="hidden"
            onChange={e => e.target.files?.[0] && importJSON(e.target.files[0])}
          />
        </label>

        {/* Divider */}
        <span className="w-px h-6 bg-neutral-400 mx-1" />

        {/* Collaboration UI */}
        <div className="flex items-center gap-1">
          <Users size={18} />
          <span className="text-sm">
            {Object.values(peerConnections).filter(p => p.status === 'connected').length + 1}
          </span>
        </div>

        {/* Share link (copy) */}
        <div className="flex items-center gap-1 ml-4">
          <button
            onClick={copyLink}
            title="Copy share link"
            className="inline-flex items-center gap-1 border border-neutral-400 dark:border-neutral-600 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-800 transition"
          >
            {linkCopied ? <Check size={14} /> : <Copy size={14} />} Link
          </button>
        </div>

        {/* Join code field */}
        <div className="flex items-center gap-1 ml-auto">
          <input
            value={joinCode}
            onChange={e => setJoinCode(e.target.value)}
            placeholder="Join code"
            className="px-2 py-1 border border-neutral-400 dark:border-neutral-600 rounded w-32 text-sm bg-white dark:bg-neutral-800 outline-none"
          />
          <button
            onClick={() => requestPeerConnection(joinCode.trim())}
            className="px-2 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
          >
            Join
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          className="w-full h-full touch-none cursor-crosshair select-none"
          onContextMenu={e => e.preventDefault()}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerLeave={finishStroke}
          // onWheel={handleWheel} // Remove the React prop, listener is added via useEffect
        />

        {/* Text input overlay */}
        {textInputPos && (
          <textarea
            autoFocus
            style={{
              top: textInputPos.y * scaleRef.current + panRef.current.y,
              left: textInputPos.x * scaleRef.current + panRef.current.x
            }}
            className="absolute bg-transparent border border-dashed border-neutral-400 text-neutral-800 dark:text-neutral-100 outline-none resize-none"
            value={textValue}
            onChange={e => setTextValue(e.target.value)}
            onBlur={confirmText}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                confirmText();
              }
            }}
          />
        )}

        {/* Incoming connection requests */}
        {incoming.map(req => (
          <div
            key={req.peerId}
            className="absolute right-4 bottom-4 bg-neutral-100 dark:bg-neutral-800 border border-neutral-400 dark:border-neutral-600 rounded shadow-lg p-3 flex items-center gap-3 mb-2"
          >
            <span className="font-medium">
              {req.name || 'Someone'} wants to join
            </span>
            <button
              onClick={() => {
                sendToServer({ type: 'connection-success', target: req.peerId });
                setIncoming(prev => prev.filter(r => r.peerId !== req.peerId));
              }}
              className="p-1 rounded bg-green-600 hover:bg-green-700 text-white"
              title="Accept"
            >
              <Check size={16} />
            </button>
            <button
              onClick={() => {
                sendToServer({ type: 'connection-declined', target: req.peerId });
                setIncoming(prev => prev.filter(r => r.peerId !== req.peerId));
              }}
              className="p-1 rounded bg-red-600 hover:bg-red-700 text-white"
              title="Decline"
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Whiteboard;
// --- END OF FILE  @/src/pages/Whiteboard.tsx ---