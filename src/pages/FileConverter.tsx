import React, { useState, useCallback, useRef, useEffect } from 'react';
import heic2any from 'heic2any';
import * as UTIF from 'utif';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { CheckCircle, XCircle, Download, Loader2, FileWarning, AlertCircle, X, Settings2, ChevronDown, Eye } from 'lucide-react';

// ── Format definitions ──────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = ['HEIC', 'JPG', 'JPEG', 'PNG', 'TIFF', 'TIF', 'DNG', 'BMP', 'WEBP', 'GIF', 'ICO', 'SVG'] as const;
const VIDEO_EXTENSIONS = ['MP4', 'MOV', 'AVI', 'MKV', 'WEBM', 'FLV', 'WMV', 'M4V', '3GP', 'OGV', 'TS', 'MPG', 'MPEG'] as const;
const AUDIO_EXTENSIONS = ['MP3', 'WAV', 'AAC', 'OGG', 'FLAC', 'M4A', 'WMA', 'OPUS', 'AIFF'] as const;

type MediaCategory = 'image' | 'video' | 'audio' | 'unknown';

interface FormatInfo {
  extension: string;
  category: MediaCategory;
  mime: string;
  ffmpegCodec?: string; // preferred codec for output
}

const FORMAT_DB: Record<string, FormatInfo> = {
  // Images
  HEIC:  { extension: 'heic',  category: 'image', mime: 'image/heic' },
  JPG:   { extension: 'jpg',   category: 'image', mime: 'image/jpeg' },
  JPEG:  { extension: 'jpeg',  category: 'image', mime: 'image/jpeg' },
  PNG:   { extension: 'png',   category: 'image', mime: 'image/png' },
  TIFF:  { extension: 'tiff',  category: 'image', mime: 'image/tiff' },
  TIF:   { extension: 'tif',   category: 'image', mime: 'image/tiff' },
  DNG:   { extension: 'dng',   category: 'image', mime: 'image/x-adobe-dng' },
  BMP:   { extension: 'bmp',   category: 'image', mime: 'image/bmp' },
  WEBP:  { extension: 'webp',  category: 'image', mime: 'image/webp' },
  GIF:   { extension: 'gif',   category: 'image', mime: 'image/gif' },
  ICO:   { extension: 'ico',   category: 'image', mime: 'image/x-icon' },
  SVG:   { extension: 'svg',   category: 'image', mime: 'image/svg+xml' },
  // Video
  MP4:   { extension: 'mp4',  category: 'video', mime: 'video/mp4',       ffmpegCodec: 'libx264' },
  MOV:   { extension: 'mov',  category: 'video', mime: 'video/quicktime', ffmpegCodec: 'libx264' },
  AVI:   { extension: 'avi',  category: 'video', mime: 'video/x-msvideo', ffmpegCodec: 'libx264' },
  MKV:   { extension: 'mkv',  category: 'video', mime: 'video/x-matroska',ffmpegCodec: 'libx264' },
  WEBM:  { extension: 'webm', category: 'video', mime: 'video/webm',      ffmpegCodec: 'libvpx' },
  FLV:   { extension: 'flv',  category: 'video', mime: 'video/x-flv',     ffmpegCodec: 'flv' },
  WMV:   { extension: 'wmv',  category: 'video', mime: 'video/x-ms-wmv',  ffmpegCodec: 'wmv2' },
  M4V:   { extension: 'm4v',  category: 'video', mime: 'video/x-m4v',     ffmpegCodec: 'libx264' },
  '3GP': { extension: '3gp',  category: 'video', mime: 'video/3gpp',      ffmpegCodec: 'libx264' },
  OGV:   { extension: 'ogv',  category: 'video', mime: 'video/ogg',       ffmpegCodec: 'libtheora' },
  TS:    { extension: 'ts',   category: 'video', mime: 'video/mp2t',      ffmpegCodec: 'libx264' },
  MPG:   { extension: 'mpg',  category: 'video', mime: 'video/mpeg',      ffmpegCodec: 'mpeg2video' },
  MPEG:  { extension: 'mpeg', category: 'video', mime: 'video/mpeg',      ffmpegCodec: 'mpeg2video' },
  // Audio
  MP3:   { extension: 'mp3',  category: 'audio', mime: 'audio/mpeg',      ffmpegCodec: 'libmp3lame' },
  WAV:   { extension: 'wav',  category: 'audio', mime: 'audio/wav',       ffmpegCodec: 'pcm_s16le' },
  AAC:   { extension: 'aac',  category: 'audio', mime: 'audio/aac',       ffmpegCodec: 'aac' },
  OGG:   { extension: 'ogg',  category: 'audio', mime: 'audio/ogg',       ffmpegCodec: 'libvorbis' },
  FLAC:  { extension: 'flac', category: 'audio', mime: 'audio/flac',      ffmpegCodec: 'flac' },
  M4A:   { extension: 'm4a',  category: 'audio', mime: 'audio/mp4',       ffmpegCodec: 'aac' },
  WMA:   { extension: 'wma',  category: 'audio', mime: 'audio/x-ms-wma',  ffmpegCodec: 'wmav2' },
  OPUS:  { extension: 'opus', category: 'audio', mime: 'audio/opus',      ffmpegCodec: 'libopus' },
  AIFF:  { extension: 'aiff', category: 'audio', mime: 'audio/aiff',      ffmpegCodec: 'pcm_s16be' },
};

// What outputs are available for each input category
const OUTPUT_FORMATS: Record<MediaCategory, string[]> = {
  image: ['JPG', 'PNG', 'WEBP', 'BMP', 'GIF', 'TIFF'],
  video: ['MP4', 'MOV', 'AVI', 'MKV', 'WEBM', 'GIF', 'MP3', 'WAV', 'AAC', 'OGG', 'FLAC', 'M4A', 'OPUS'],
  audio: ['MP3', 'WAV', 'AAC', 'OGG', 'FLAC', 'M4A', 'OPUS', 'AIFF'],
  unknown: [],
};

const RESOLUTION_PRESETS = [
  { label: 'Original', value: 'original' },
  { label: '4K (2160p)', value: '3840:-2' },
  { label: '1080p', value: '1920:-2' },
  { label: '720p', value: '1280:-2' },
  { label: '480p', value: '854:-2' },
  { label: '360p', value: '640:-2' },
  { label: '240p', value: '426:-2' },
] as const;

function detectCategory(ext: string): MediaCategory {
  const upper = ext.toUpperCase();
  if (IMAGE_EXTENSIONS.includes(upper as any)) return 'image';
  if (VIDEO_EXTENSIONS.includes(upper as any)) return 'video';
  if (AUDIO_EXTENSIONS.includes(upper as any)) return 'audio';
  return 'unknown';
}

function normalizeExtension(ext: string): string {
  const upper = ext.toUpperCase();
  if (upper === 'JPEG') return 'JPG';
  if (upper === 'TIF') return 'TIFF';
  return upper;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface FileStatus {
  file: File;
  id: string;
  inputFormat: string | null;
  inputCategory: MediaCategory;
  status: 'pending' | 'converting' | 'done' | 'error';
  outputFormat?: string;
  resultUrl?: string;
  error?: string;
  outputFilename?: string;
  progress?: number; // 0-100
}

interface ConversionSettings {
  resolution: string; // 'original' or 'WxH' ffmpeg scale
  quality: number; // 1-100
  targetSizeMB: number | null; // null = don't target size
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// ── Component ───────────────────────────────────────────────────────────────

const FileConverter: React.FC = () => {
  const [filesToProcess, setFilesToProcess] = useState<FileStatus[]>([]);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<ConversionSettings>({
    resolution: 'original',
    quality: 80,
    targetSizeMB: null,
  });

  const ffmpegRef = useRef(new FFmpeg());
  const ffmpegLoadingStarted = useRef(false);
  const filesToProcessRef = useRef(filesToProcess);

  useEffect(() => { filesToProcessRef.current = filesToProcess; }, [filesToProcess]);

  // ── Load FFmpeg (multi-threaded if possible, single-threaded fallback) ──
  useEffect(() => {
    const loadFFmpeg = async () => {
      if (ffmpegLoadingStarted.current) return;
      ffmpegLoadingStarted.current = true;

      setOverallError("Loading FFmpeg component...");

      const canUseThreads = typeof SharedArrayBuffer !== 'undefined';

      if (canUseThreads) {
        try {
          const ffmpeg = ffmpegRef.current;
          await ffmpeg.load({
            coreURL: '/ffmpeg-mt/ffmpeg-core.js',
            wasmURL: '/ffmpeg-mt/ffmpeg-core.wasm',
            workerURL: '/ffmpeg-mt/ffmpeg-core.worker.js',
          });
          console.log("FFmpeg loaded (multi-threaded)");
          setFfmpegLoaded(true);
          setOverallError(null);
          return;
        } catch (e) {
          console.warn("Multi-threaded FFmpeg failed, trying single-threaded:", e);
        }
      }

      // Single-threaded fallback
      try {
        const ffmpeg = new FFmpeg();
        ffmpegRef.current = ffmpeg;
        await ffmpeg.load({
          coreURL: '/ffmpeg-st/ffmpeg-core.js',
          wasmURL: '/ffmpeg-st/ffmpeg-core.wasm',
        });
        console.log("FFmpeg loaded (single-threaded)");
        setFfmpegLoaded(true);
        setOverallError(null);
      } catch (fallbackError) {
        const errorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        setOverallError(`FFmpeg load failed: ${errorMessage}. Video/audio conversion disabled.`);
        setFfmpegLoaded(false);
      }
    };
    loadFFmpeg();
  }, []);

  // ── Cleanup blob URLs on unmount ────────────────────────────────────────
  useEffect(() => {
    return () => {
      filesToProcessRef.current.forEach(fs => {
        if (fs.resultUrl) URL.revokeObjectURL(fs.resultUrl);
      });
    };
  }, []);

  // ── Derive available output formats from loaded files ───────────────────
  const inputCategories = new Set(filesToProcess.filter(f => f.status === 'pending').map(f => f.inputCategory));

  const availableOutputFormats = (() => {
    const formats = new Set<string>();
    inputCategories.forEach(cat => {
      OUTPUT_FORMATS[cat]?.forEach(f => formats.add(f));
    });
    return Array.from(formats);
  })();

  // Group available formats by category for the dropdown
  const groupedOutputFormats = (() => {
    const groups: Record<string, string[]> = { Images: [], Video: [], Audio: [] };
    availableOutputFormats.forEach(f => {
      const info = FORMAT_DB[f];
      if (!info) return;
      if (info.category === 'image') groups['Images'].push(f);
      else if (info.category === 'video') groups['Video'].push(f);
      else if (info.category === 'audio') groups['Audio'].push(f);
    });
    // Remove empty groups
    Object.keys(groups).forEach(k => { if (groups[k].length === 0) delete groups[k]; });
    return groups;
  })();

  // ── File input processing ───────────────────────────────────────────────
  const processInputFiles = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const newFiles: FileStatus[] = Array.from(files).map((file: File) => {
      const extension = file.name.split('.').pop()?.toUpperCase() || '';
      const normalized = normalizeExtension(extension);
      const category = detectCategory(extension);
      return {
        file,
        id: `${file.name}-${file.lastModified}-${Math.random()}`,
        inputFormat: category !== 'unknown' ? normalized : null,
        inputCategory: category,
        status: 'pending',
      };
    });
    setFilesToProcess(prev => [...prev, ...newFiles]);
    setOverallError(null);
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    processInputFiles(event.target.files);
    event.target.value = '';
  };

  // ── Drag and drop ─────────────────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    processInputFiles(e.dataTransfer.files);
  }, [processInputFiles]);

  // ── Paste handler ─────────────────────────────────────────────────────
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      processInputFiles(event.clipboardData?.files);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [processInputFiles]);

  // ── Format compatibility check ──────────────────────────────────────
  const isFormatCompatible = useCallback((fileStatus: FileStatus, targetFormat: string): boolean => {
    if (!fileStatus.inputFormat) return false;
    const inputCat = fileStatus.inputCategory;
    const outputInfo = FORMAT_DB[targetFormat];
    if (!outputInfo) return false;

    // Image → Image (handled by canvas/heic2any)
    if (inputCat === 'image' && outputInfo.category === 'image') return true;

    // Video → Video, Video → Audio, Video → GIF (needs FFmpeg)
    if (inputCat === 'video' && (outputInfo.category === 'video' || outputInfo.category === 'audio' || targetFormat === 'GIF')) {
      return ffmpegLoaded;
    }

    // Audio → Audio (needs FFmpeg)
    if (inputCat === 'audio' && outputInfo.category === 'audio') {
      return ffmpegLoaded;
    }

    return false;
  }, [ffmpegLoaded]);

  // ── State helpers ─────────────────────────────────────────────────────
  const updateFileStatus = useCallback((id: string, updates: Partial<FileStatus>) => {
    setFilesToProcess(prev => prev.map(fs => (fs.id === id ? { ...fs, ...updates } : fs)));
  }, []);

  const removeFile = (id: string) => {
    setFilesToProcess(prev => {
      const fileToRemove = prev.find(fs => fs.id === id);
      if (fileToRemove?.resultUrl) URL.revokeObjectURL(fileToRemove.resultUrl);
      return prev.filter(fs => fs.id !== id);
    });
  };

  // ── Build FFmpeg command ──────────────────────────────────────────────
  const buildFFmpegCommand = (
    inputFilename: string,
    outputFilename: string,
    outputFormat: string,
    inputCategory: MediaCategory,
    fileSizeBytes: number,
  ): string[] => {
    const outputInfo = FORMAT_DB[outputFormat];
    // Cap threads at 4 — higher values hang in Chrome's WASM memory limits
    const cmd: string[] = ['-threads', '4', '-i', inputFilename];

    const isAudioOutput = outputInfo?.category === 'audio';
    const isVideoOutput = outputInfo?.category === 'video' || outputFormat === 'GIF';

    if (isAudioOutput) {
      // Strip video for audio-only output
      cmd.push('-vn');
    }

    // Target file size mode
    if (settings.targetSizeMB && !isAudioOutput && inputCategory === 'video') {
      // Estimate: targetSizeMB * 8192 kbits / duration_seconds
      // We don't know duration, so use a rough heuristic based on input file size
      // Assume similar duration, scale bitrate proportionally
      const targetBytes = settings.targetSizeMB * 1024 * 1024;
      const ratio = targetBytes / fileSizeBytes;
      // Rough: original might be ~5000kbps, scale down
      const estimatedBitrate = Math.max(100, Math.floor(5000 * ratio));
      cmd.push('-b:v', `${estimatedBitrate}k`);
    }

    // Resolution
    if (settings.resolution !== 'original' && isVideoOutput && outputFormat !== 'GIF') {
      cmd.push('-vf', `scale=${settings.resolution}`);
    }

    // Quality
    if (!settings.targetSizeMB) {
      if (isVideoOutput && outputFormat !== 'GIF') {
        // CRF-based quality (lower = better, 0-51 for x264)
        // Map quality 1-100 → CRF 51-18
        const crf = Math.round(51 - (settings.quality / 100) * 33);
        if (outputFormat === 'WEBM') {
          cmd.push('-crf', String(crf), '-b:v', '0');
        } else {
          cmd.push('-crf', String(crf));
        }
      } else if (isAudioOutput) {
        // Map quality to audio bitrate: 1→64k, 100→320k
        const audioBitrate = Math.round(64 + (settings.quality / 100) * 256);
        if (outputInfo?.ffmpegCodec !== 'pcm_s16le' && outputInfo?.ffmpegCodec !== 'pcm_s16be' && outputInfo?.ffmpegCodec !== 'flac') {
          cmd.push('-ab', `${audioBitrate}k`);
        }
      }
    }

    // Codec selection
    if (isVideoOutput && outputFormat !== 'GIF') {
      const codec = outputInfo?.ffmpegCodec || 'libx264';
      cmd.push('-c:v', codec);

      // Audio codec for video outputs
      if (outputFormat === 'WEBM') {
        cmd.push('-c:a', 'libvorbis');
      } else if (outputFormat === 'OGV') {
        cmd.push('-c:a', 'libvorbis');
      } else {
        cmd.push('-c:a', 'aac');
      }

      // Speed preset
      if (['libx264', 'libx265'].includes(outputInfo?.ffmpegCodec || '')) {
        cmd.push('-preset', 'ultrafast');
      }

      // Movflags for MP4/MOV
      if (['MP4', 'MOV', 'M4V'].includes(outputFormat)) {
        cmd.push('-movflags', '+faststart');
      }
    } else if (outputFormat === 'GIF') {
      // GIF from video: scale down and limit fps
      const scaleFilter = settings.resolution !== 'original' ? `scale=${settings.resolution}` : 'scale=480:-2';
      cmd.push('-vf', `${scaleFilter},fps=15`);
    } else if (isAudioOutput) {
      const codec = outputInfo?.ffmpegCodec || 'libmp3lame';
      cmd.push('-acodec', codec);
    }

    // Resolution override for video with target size
    if (settings.resolution !== 'original' && isVideoOutput && outputFormat !== 'GIF' && settings.targetSizeMB) {
      // Need to combine with existing -vf or add it
      const existingVfIndex = cmd.indexOf('-vf');
      if (existingVfIndex === -1) {
        cmd.push('-vf', `scale=${settings.resolution}`);
      }
    }

    cmd.push(outputFilename);
    return cmd;
  };

  // ── Image conversion (canvas-based) ───────────────────────────────────
  const convertImage = async (file: File, inputFormat: string, outputFormat: string): Promise<Blob> => {
    const outputInfo = FORMAT_DB[outputFormat];
    const outputMimeType = outputInfo?.mime || `image/${outputFormat.toLowerCase()}`;
    const quality = settings.quality / 100;

    // HEIC special handling
    if (inputFormat === 'HEIC') {
      let intermediateBlob: Blob;
      const heicResult = await heic2any({ blob: file, toType: 'image/png', quality: 0.95 });
      intermediateBlob = Array.isArray(heicResult) ? heicResult[0] : heicResult;

      if (outputFormat === 'PNG') return intermediateBlob;

      // Convert intermediate PNG to target format via canvas
      return new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Failed to get canvas context'));
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error(`Canvas toBlob failed for ${outputFormat}`)),
            outputMimeType,
            quality
          );
        };
        img.onerror = () => reject(new Error('Failed to load HEIC intermediate image'));
        img.src = URL.createObjectURL(intermediateBlob);
      });
    }

    // TIFF/DNG via UTIF
    if (inputFormat === 'TIFF' || inputFormat === 'DNG') {
      return new Promise<Blob>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          if (!e.target?.result || !(e.target.result instanceof ArrayBuffer)) {
            return reject(new Error(`${inputFormat} file could not be read.`));
          }
          try {
            const buffer = e.target.result as ArrayBuffer;
            const ifds = UTIF.decode(buffer);
            UTIF.decodeImage(buffer, ifds[0]);
            const width = ifds[0].width;
            const height = ifds[0].height;
            const rgba = UTIF.toRGBA8(ifds[0]);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) return reject(new Error('Failed to get Canvas 2D context.'));
            const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
            ctx.putImageData(imageData, 0, 0);
            canvas.toBlob(
              blob => blob ? resolve(blob) : reject(new Error(`Canvas toBlob failed for ${outputFormat}`)),
              outputMimeType,
              quality
            );
          } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error(`File Reader error: ${reader.error?.message}`));
        reader.readAsArrayBuffer(file);
      });
    }

    // Standard image via canvas (JPG, PNG, BMP, WEBP, GIF, etc.)
    return new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = (e) => {
        if (!e.target?.result) return reject(new Error('File could not be read.'));
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return reject(new Error('Failed to get Canvas 2D context.'));
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error(`Canvas toBlob failed for ${outputFormat}. ${outputFormat === 'TIFF' ? 'TIFF output may be unsupported by your browser.' : ''}`)),
            outputMimeType,
            quality
          );
        };
        img.onerror = () => reject(new Error('Image could not be loaded'));
        img.src = e.target.result as string;
      };
      reader.onerror = () => reject(new Error(`File Reader error: ${reader.error?.message}`));
      reader.readAsDataURL(file);
    });
  };

  // ── FFmpeg-based conversion ───────────────────────────────────────────
  const convertWithFFmpeg = async (fileStatus: FileStatus, outputFormat: string): Promise<Blob> => {
    const ffmpeg = ffmpegRef.current;
    const { file, inputFormat } = fileStatus;
    const inputExt = (inputFormat || file.name.split('.').pop() || 'bin').toLowerCase();
    const outputExt = (FORMAT_DB[outputFormat]?.extension || outputFormat.toLowerCase());
    const inputFilename = `input_${fileStatus.id}.${inputExt}`;
    const outputFilename = `output_${fileStatus.id}.${outputExt}`;

    await ffmpeg.writeFile(inputFilename, await fetchFile(file));

    const command = buildFFmpegCommand(inputFilename, outputFilename, outputFormat, fileStatus.inputCategory, file.size);
    console.log("FFmpeg command:", command.join(' '));
    await ffmpeg.exec(command);

    const data = await ffmpeg.readFile(outputFilename);
    const mime = FORMAT_DB[outputFormat]?.mime || 'application/octet-stream';
    const blob = new Blob([data], { type: mime });

    // Cleanup
    try {
      await ffmpeg.deleteFile(inputFilename);
      await ffmpeg.deleteFile(outputFilename);
    } catch { /* cleanup failures are fine */ }

    return blob;
  };

  // ── Two-pass for target file size ─────────────────────────────────────
  const convertWithTargetSize = async (fileStatus: FileStatus, outputFormat: string): Promise<Blob> => {
    // First pass: convert normally
    let blob = await convertWithFFmpeg(fileStatus, outputFormat);
    const targetBytes = (settings.targetSizeMB || 0) * 1024 * 1024;

    if (!settings.targetSizeMB || blob.size <= targetBytes) return blob;

    // If still too large, try again with lower quality
    const origQuality = settings.quality;
    const ratio = targetBytes / blob.size;
    settings.quality = Math.max(10, Math.floor(origQuality * ratio * 0.8));
    blob = await convertWithFFmpeg(fileStatus, outputFormat);
    settings.quality = origQuality;

    return blob;
  };

  // ── Process all files ─────────────────────────────────────────────────
  const processFiles = useCallback(async () => {
    if (!selectedOutputFormat) {
      setOverallError("Please choose an output format.");
      return;
    }

    const filesToRun = filesToProcess.filter(fs => fs.status === 'pending' && isFormatCompatible(fs, selectedOutputFormat));
    if (filesToRun.length === 0) {
      const pendingCount = filesToProcess.filter(fs => fs.status === 'pending').length;
      setOverallError(pendingCount > 0 ? "No pending files are compatible with the selected output format." : "No pending files to process.");
      return;
    }

    const needsFFmpeg = filesToRun.some(fs => fs.inputCategory === 'video' || fs.inputCategory === 'audio');
    if (needsFFmpeg && !ffmpegLoaded) {
      setOverallError("FFmpeg is not ready, cannot process video/audio formats.");
      return;
    }

    setIsProcessing(true);
    setOverallError(null);

    for (const fileStatus of filesToRun) {
      const outputExt = FORMAT_DB[selectedOutputFormat]?.extension || selectedOutputFormat.toLowerCase();
      const baseName = fileStatus.file.name.split('.').slice(0, -1).join('.') || fileStatus.id;
      const outputFilename = `${baseName}.${outputExt}`;

      updateFileStatus(fileStatus.id, { status: 'converting', outputFormat: selectedOutputFormat, outputFilename });

      try {
        let outputBlob: Blob | null = null;
        const outputInfo = FORMAT_DB[selectedOutputFormat];

        if (fileStatus.inputCategory === 'image' && outputInfo?.category === 'image') {
          // Image → Image
          outputBlob = await convertImage(fileStatus.file, fileStatus.inputFormat!, selectedOutputFormat);
        } else if (
          (fileStatus.inputCategory === 'video' || fileStatus.inputCategory === 'audio') &&
          (outputInfo?.category === 'video' || outputInfo?.category === 'audio' || selectedOutputFormat === 'GIF')
        ) {
          // Video/Audio → Video/Audio/GIF via FFmpeg
          if (settings.targetSizeMB) {
            outputBlob = await convertWithTargetSize(fileStatus, selectedOutputFormat);
          } else {
            outputBlob = await convertWithFFmpeg(fileStatus, selectedOutputFormat);
          }
        }

        if (outputBlob) {
          const url = URL.createObjectURL(outputBlob);
          updateFileStatus(fileStatus.id, { status: 'done', resultUrl: url });
        } else {
          throw new Error('Conversion did not produce output.');
        }
      } catch (error) {
        console.error(`Conversion failed for ${fileStatus.file.name}:`, error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        updateFileStatus(fileStatus.id, { status: 'error', error: errorMsg });
      }
    }

    setIsProcessing(false);
  }, [filesToProcess, selectedOutputFormat, ffmpegLoaded, isFormatCompatible, updateFileStatus, settings]);

  // ── Derived state for UI ──────────────────────────────────────────────
  const pendingCompatibleFileCount = filesToProcess.filter(
    fs => fs.status === 'pending' && selectedOutputFormat && isFormatCompatible(fs, selectedOutputFormat)
  ).length;

  const showVideoSettings = selectedOutputFormat && (
    FORMAT_DB[selectedOutputFormat]?.category === 'video' ||
    FORMAT_DB[selectedOutputFormat]?.category === 'audio' ||
    selectedOutputFormat === 'GIF'
  );

  const allAcceptedExtensions = [
    ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS
  ].map(e => `.${e.toLowerCase()}`).join(',');

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div
      className="relative p-6 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 min-h-screen transition-colors duration-300 flex flex-col"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 bg-blue-500/30 dark:bg-blue-800/30 border-4 border-dashed border-blue-600 dark:border-blue-400 rounded-lg flex items-center justify-center pointer-events-none z-50">
          <p className="text-2xl font-semibold text-blue-800 dark:text-blue-200">Drop files here</p>
        </div>
      )}

      <h1 className="text-3xl font-bold mb-6">File Converter</h1>
      <p className="text-neutral-600 dark:text-neutral-400 mb-6 text-sm">
        Convert files directly in your browser. Your files stay on your device. Supports images (HEIC, JPG, PNG, WEBP, BMP, GIF, TIFF, DNG), video (MP4, MOV, AVI, MKV, WEBM, and more), and audio (MP3, WAV, AAC, OGG, FLAC, OPUS, and more).
      </p>

      {overallError && !isProcessing && !overallError.startsWith("Loading FFmpeg") && (
        <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-600 text-red-800 dark:text-red-300 rounded text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{overallError}</span>
        </div>
      )}
      {overallError?.startsWith("Loading FFmpeg") && (
        <div className="mb-4 p-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-600 text-blue-800 dark:text-blue-300 rounded text-sm flex items-center gap-2">
          <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
          <span>{overallError}</span>
        </div>
      )}

      <div className="flex-grow flex flex-col md:flex-row gap-6">
        {/* ── Left panel ──────────────────────────────────────────────── */}
        <div className="w-full md:w-1/3 lg:w-1/4 flex flex-col gap-4">
          <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
            <h2 className="text-lg font-semibold mb-3">1. Input & Format</h2>

            {/* File input */}
            <div className="mb-4">
              <label htmlFor="file-input" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Choose Files:</label>
              <input
                id="file-input"
                type="file"
                multiple
                onChange={handleFileChange}
                className="block w-full text-sm text-neutral-500 dark:text-neutral-400 file:mr-4 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-500 file:text-white hover:file:bg-blue-600 cursor-pointer border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 p-1"
                disabled={isProcessing}
                accept={allAcceptedExtensions}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Images, video, and audio files</p>
            </div>

            {/* Output format select */}
            <div className="mb-4">
              <label htmlFor="output-format" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Convert To:</label>
              <select
                id="output-format"
                value={selectedOutputFormat}
                onChange={(e) => setSelectedOutputFormat(e.target.value)}
                className="block w-full px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm disabled:opacity-50"
                disabled={isProcessing || filesToProcess.length === 0}
              >
                <option value="" disabled>-- Select Format --</option>
                {Object.entries(groupedOutputFormats).map(([group, formats]) => (
                  <optgroup key={group} label={group}>
                    {formats.map(f => {
                      const needsFF = FORMAT_DB[f]?.category === 'video' || FORMAT_DB[f]?.category === 'audio';
                      const disabled = needsFF && !ffmpegLoaded;
                      return (
                        <option key={f} value={f} disabled={disabled}>
                          {f}{disabled ? ' (loading...)' : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              {!ffmpegLoaded && overallError && !overallError.startsWith("Loading FFmpeg") && (
                <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> FFmpeg failed to load. Video/audio disabled.
                </p>
              )}
              {overallError?.startsWith("Loading FFmpeg") && (
                <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading video/audio support...
                </p>
              )}
            </div>

            {/* Settings toggle */}
            {selectedOutputFormat && (
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="flex items-center gap-1.5 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 mb-3 transition-colors"
              >
                <Settings2 className="w-4 h-4" />
                <span>Conversion Settings</span>
                <ChevronDown className={`w-3 h-3 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
              </button>
            )}

            {/* Settings panel */}
            {showSettings && selectedOutputFormat && (
              <div className="mb-4 p-3 border border-neutral-200 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 space-y-3">
                {/* Quality slider */}
                <div>
                  <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                    Quality: {settings.quality}%
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={settings.quality}
                    onChange={(e) => setSettings(s => ({ ...s, quality: Number(e.target.value) }))}
                    className="w-full h-1.5 bg-neutral-200 dark:bg-neutral-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
                  />
                  <div className="flex justify-between text-[10px] text-neutral-400">
                    <span>Smaller</span>
                    <span>Higher Quality</span>
                  </div>
                </div>

                {/* Resolution (only for video/gif outputs) */}
                {showVideoSettings && selectedOutputFormat !== 'GIF' && FORMAT_DB[selectedOutputFormat]?.category !== 'audio' && (
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">Resolution:</label>
                    <select
                      value={settings.resolution}
                      onChange={(e) => setSettings(s => ({ ...s, resolution: e.target.value }))}
                      className="block w-full px-2 py-1 border border-neutral-300 dark:border-neutral-500 rounded bg-white dark:bg-neutral-600 text-sm"
                    >
                      {RESOLUTION_PRESETS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Target file size (only for video) */}
                {showVideoSettings && FORMAT_DB[selectedOutputFormat]?.category !== 'audio' && (
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">
                      Target File Size (MB):
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min="1"
                        max="4096"
                        placeholder="Auto"
                        value={settings.targetSizeMB || ''}
                        onChange={(e) => setSettings(s => ({ ...s, targetSizeMB: e.target.value ? Number(e.target.value) : null }))}
                        className="block w-full px-2 py-1 border border-neutral-300 dark:border-neutral-500 rounded bg-white dark:bg-neutral-600 text-sm"
                      />
                      {settings.targetSizeMB && (
                        <button
                          onClick={() => setSettings(s => ({ ...s, targetSizeMB: null }))}
                          className="text-xs text-neutral-500 hover:text-red-500"
                          title="Clear target size"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-neutral-400 mt-0.5">Leave empty for automatic. Overrides quality setting.</p>
                  </div>
                )}
              </div>
            )}

            {/* Convert button */}
            <button
              onClick={processFiles}
              disabled={pendingCompatibleFileCount === 0 || !selectedOutputFormat || isProcessing}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm transition-opacity"
            >
              {isProcessing ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
              ) : (
                `Convert ${pendingCompatibleFileCount} File(s)`
              )}
            </button>
          </div>
        </div>

        {/* ── Right panel: file list ──────────────────────────────────── */}
        <div className="w-full md:w-2/3 lg:w-3/4 flex flex-col">
          <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800 flex-grow overflow-y-auto min-h-[200px]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">2. Files & Progress</h2>
              {filesToProcess.filter(fs => fs.status === 'done' && fs.resultUrl).length > 1 && (
                <button
                  onClick={() => {
                    const doneFiles = filesToProcess.filter(fs => fs.status === 'done' && fs.resultUrl);
                    doneFiles.forEach((fs, i) => {
                      setTimeout(() => {
                        const a = document.createElement('a');
                        a.href = fs.resultUrl!;
                        a.download = fs.outputFilename || `converted_${fs.file.name}`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                      }, i * 300); // stagger to avoid browser blocking
                    });
                  }}
                  className="flex items-center gap-1.5 text-sm bg-green-600 hover:bg-green-700 text-white font-medium py-1.5 px-3 rounded transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download All ({filesToProcess.filter(fs => fs.status === 'done' && fs.resultUrl).length})
                </button>
              )}
            </div>
            {filesToProcess.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">Add files using the panel on the left, drag & drop, or paste.</p>
            ) : (
              <ul className="space-y-2">
                {filesToProcess.map((fs) => {
                  const isCompatible = selectedOutputFormat ? isFormatCompatible(fs, selectedOutputFormat) : false;
                  return (
                    <li key={fs.id} className={`flex items-center justify-between text-sm p-2 rounded border ${
                      fs.status === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700/50' :
                      fs.status === 'done' ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700/50' :
                      fs.status === 'converting' ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700/50' :
                      'bg-neutral-100 dark:bg-neutral-700 border-neutral-200 dark:border-neutral-600'
                    } ${(!isCompatible && fs.status === 'pending' && selectedOutputFormat) ? 'opacity-60' : ''}`}>
                      <div className="flex-1 overflow-hidden mr-2">
                        <p className="font-medium truncate" title={fs.file.name}>{fs.file.name}</p>
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          {fs.inputFormat || 'Unknown type'}
                          {fs.inputCategory !== 'unknown' && ` (${fs.inputCategory})`}
                          {fs.outputFormat && ` → ${fs.outputFormat}`}
                          {` (${formatFileSize(fs.file.size)})`}
                          {(!isCompatible && fs.status === 'pending' && selectedOutputFormat) && (
                            <span className="text-yellow-600 dark:text-yellow-400"> (Incompatible)</span>
                          )}
                        </p>
                        {(fs.status === 'converting' || fs.status === 'done' || fs.status === 'error') && (
                          <div className="w-full bg-neutral-200 dark:bg-neutral-600 rounded h-1 mt-1 overflow-hidden">
                            <div className={`h-1 rounded transition-all duration-300 ${
                              fs.status === 'error' ? 'bg-red-500 w-full' :
                              fs.status === 'done' ? 'bg-green-500 w-full' :
                              fs.status === 'converting' ? 'bg-blue-500 w-1/2 animate-pulse' :
                              'bg-transparent w-0'
                            }`} />
                          </div>
                        )}
                        {fs.status === 'error' && fs.error && (
                          <p className="text-xs text-red-600 dark:text-red-400 mt-1 truncate" title={fs.error}>Error: {fs.error}</p>
                        )}
                      </div>
                      <div className="flex items-center space-x-2 flex-shrink-0">
                        {fs.status === 'pending' && !isCompatible && selectedOutputFormat && (
                          <span title="Incompatible for selected output"><FileWarning className="w-4 h-4 text-yellow-600 dark:text-yellow-500" /></span>
                        )}
                        {fs.status === 'pending' && (!selectedOutputFormat || isCompatible) && (
                          <span className="text-xs text-neutral-500 dark:text-neutral-400">Ready</span>
                        )}
                        {fs.status === 'converting' && (
                          <span title="Converting..."><Loader2 className="w-4 h-4 animate-spin text-blue-500" /></span>
                        )}
                        {fs.status === 'done' && fs.resultUrl && (
                          <>
                            {fs.outputFormat && ['image', 'video', 'audio'].includes(FORMAT_DB[fs.outputFormat]?.category || '') && (
                              <a
                                href={fs.resultUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 rounded hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
                                title="Preview in new tab"
                              >
                                <Eye className="w-4 h-4" />
                              </a>
                            )}
                            <a
                              href={fs.resultUrl}
                              download={fs.outputFilename || `converted_${fs.file.name}`}
                              className="p-1 text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 rounded hover:bg-green-100 dark:hover:bg-green-800 transition-colors"
                              title={`Download ${fs.outputFilename}`}
                            >
                              <Download className="w-4 h-4" />
                            </a>
                          </>
                        )}
                        {fs.status === 'error' && (
                          <span title={fs.error || 'Conversion failed'}><XCircle className="w-4 h-4 text-red-500" /></span>
                        )}
                        <button
                          onClick={() => removeFile(fs.id)}
                          disabled={isProcessing && fs.status === 'converting'}
                          className="p-1 text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400 rounded hover:bg-neutral-200 dark:hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="Remove file"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {filesToProcess.length > 0 && filesToProcess.some(fs => fs.status === 'error') && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-3">Some files failed. Check individual file status above.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileConverter;
