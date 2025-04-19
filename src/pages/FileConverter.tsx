import React, { useState, useCallback, useRef, useEffect } from 'react';
import heic2any from 'heic2any';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util'; // toBlobURL is not strictly needed for this implementation anymore
import { CheckCircle, XCircle, Download, Loader2, FileWarning, AlertCircle, X } from 'lucide-react';

// Define types more robustly
type SupportedImageInput = 'HEIC' | 'JPG' | 'PNG' | 'TIFF';
type SupportedVideoInput = 'MP4';
type SupportedDocumentInput = 'DOCX'; // Keep for future reference
type SupportedInput = SupportedImageInput | SupportedVideoInput | SupportedDocumentInput;

type SupportedImageOutput = 'JPG' | 'PNG' | 'TIFF'; // Added TIFF output
type SupportedVideoOutput = 'MOV';
type SupportedAudioOutput = 'MP3' | 'WAV';
type SupportedDocumentOutput = 'PDF'; // Keep for future reference
type PossibleOutputFormat = SupportedImageOutput | SupportedVideoOutput | SupportedAudioOutput | SupportedDocumentOutput;

// Interface for tracking individual file status
interface FileStatus {
  file: File;
  id: string; // Unique ID for React key
  inputFormat: SupportedInput | null;
  status: 'pending' | 'converting' | 'done' | 'error';
  outputFormat?: PossibleOutputFormat; // Track the format it was converted to
  resultUrl?: string; // URL for the converted file blob
  error?: string; // Error message if conversion failed
  outputFilename?: string; // Store the generated output filename
}

// Helper function (defined outside the component)
const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]; // Use 1 decimal place
};


const FileConverter: React.FC = () => {
  // --- State Hooks ---
  const [filesToProcess, setFilesToProcess] = useState<FileStatus[]>([]);
  const [selectedOutputFormat, setSelectedOutputFormat] = useState<PossibleOutputFormat | ''>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [overallError, setOverallError] = useState<string | null>(null);
  const [showFormatWarning, setShowFormatWarning] = useState(false);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState<boolean>(false); // State for drag overlay

  // --- Ref Hooks ---
  const ffmpegRef = useRef(new FFmpeg());
  const ffmpegLoadingStarted = useRef(false); // Track loading initiation
  const filesToProcessRef = useRef(filesToProcess); // Ref to access latest state in cleanup

  // --- Effect to keep filesToProcessRef updated ---
  // This runs whenever filesToProcess changes, ensuring the cleanup effect
  // always has access to the latest list via the ref.
  useEffect(() => {
    filesToProcessRef.current = filesToProcess;
  }, [filesToProcess]);

  // --- Effect to Load FFmpeg (ESM version) ---
  useEffect(() => {
    const loadFFmpeg = async () => {
      const ffmpeg = ffmpegRef.current;

      const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
      const coreURL = `${baseURL}/ffmpeg-core.js`;
      const wasmURL = `${baseURL}/ffmpeg-core.wasm`;
      const workerURL = `${baseURL}/ffmpeg-core.worker.js`;

      ffmpeg.on('log', ({ message }) => {
        // console.log('[FFmpeg log]', message); // Uncomment for debugging FFmpeg
      });

      if (ffmpegLoadingStarted.current || ffmpeg.loaded) {
          console.log("FFmpeg loading already initiated or complete, skipping.");
          if (ffmpeg.loaded && !ffmpegLoaded) setFfmpegLoaded(true);
          return;
      }
      ffmpegLoadingStarted.current = true;

      try {
        console.log("Attempting to load FFmpeg ESM core from CDN...");
        setOverallError("Loading FFmpeg component (ESM)...");

        console.log(`Core URL: ${coreURL}`);
        console.log(`WASM URL: ${wasmURL}`);
        console.log(`Worker URL: ${workerURL}`);
        console.log(`crossOriginIsolated: ${self.crossOriginIsolated}`);

        await ffmpeg.load({ coreURL, wasmURL, workerURL });

        console.log("FFmpeg ESM core loaded successfully from CDN.");
        setFfmpegLoaded(true);
        setOverallError(null);

      } catch (loadError) {
          console.error("FFmpeg (ESM) loading failed:", loadError);
          console.error("Detailed load error object:", loadError);
          const errorMessage = loadError instanceof Error ? loadError.message : String(loadError);
          setOverallError(`FFmpeg load failed: ${errorMessage}. Video/audio conversion disabled. Ensure cross-origin isolation headers (COOP/COEP) are set if necessary.`);
          setFfmpegLoaded(false);
      }
    };

    loadFFmpeg();

  }, []); // Empty dependency array: runs once on mount

  // --- Effect for Blob URL Cleanup on Unmount ---
  useEffect(() => {
    // This setup runs once on mount.
    // The returned cleanup function runs ONLY when the component unmounts.
    return () => {
        console.log("Component unmounting, revoking Blob URLs...");
        // Access the latest file list via the ref's .current property
        const currentFiles = filesToProcessRef.current;
        currentFiles.forEach(fs => {
            if (fs.resultUrl) {
                URL.revokeObjectURL(fs.resultUrl);
                console.log(`Revoked blob URL on unmount: ${fs.file.name} (${fs.resultUrl})`);
            }
        });
        // Optional: Terminate ffmpeg worker on unmount if needed for stricter cleanup
        // if (ffmpegRef.current.loaded) {
        //    try { ffmpegRef.current.terminate(); console.log("FFmpeg terminated on unmount."); }
        //    catch (e) { console.warn("FFmpeg terminate failed on unmount", e); }
        // }
    };
  }, []); // Empty dependency array: cleanup runs only on unmount

  // --- Event Handlers & Logic ---

  // Combined file processing logic for select, drop, and paste
  const processInputFiles = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;

    const newFiles: FileStatus[] = Array.from(files).map((file: File) => { // Explicitly type 'file' here
      const extension = file.name.split('.').pop()?.toUpperCase();
      let inputFormat: SupportedInput | null = null;
      if (extension === 'HEIC') inputFormat = 'HEIC';
      else if (extension === 'JPG' || extension === 'JPEG') inputFormat = 'JPG';
      else if (extension === 'PNG') inputFormat = 'PNG';
      else if (extension === 'TIFF' || extension === 'TIF') inputFormat = 'TIFF';
      else if (extension === 'MP4') inputFormat = 'MP4';
      else if (extension === 'DOCX') inputFormat = 'DOCX';

      return {
        file,
        id: `${file.name}-${file.lastModified}-${Math.random()}`,
        inputFormat,
        status: 'pending',
      };
    });
    setFilesToProcess(prevFiles => [...prevFiles, ...newFiles]);
    setOverallError(null);
  }, []); // No dependencies needed

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    processInputFiles(event.target.files);
    event.target.value = ''; // Reset file input after selection
  };

  // Drag and Drop Handlers
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
      e.preventDefault(); // Necessary to allow drop
      e.stopPropagation();
      setIsDragging(true); // Keep dragging state active
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      processInputFiles(e.dataTransfer.files);
  }, [processInputFiles]);

  // Paste Event Listener Effect
  useEffect(() => {
      const handlePaste = (event: ClipboardEvent) => {
        // Check if the event target is an input/textarea to avoid interfering
        const target = event.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
            return;
        }
        processInputFiles(event.clipboardData?.files);
      };
      document.addEventListener('paste', handlePaste);
      return () => {
          document.removeEventListener('paste', handlePaste);
      };
  }, [processInputFiles]);


  // --- MOVE FUNCTIONS INSIDE COMPONENT ---
  const handleOutputFormatChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
      const selectedFormat = event.target.value as PossibleOutputFormat;
      setSelectedOutputFormat(selectedFormat);
      setShowFormatWarning(['MOV', 'MP3', 'WAV'].includes(selectedFormat));
  };

  const isFormatCompatible = useCallback((fileStatus: FileStatus, targetFormat: PossibleOutputFormat): boolean => {
      if (!fileStatus.inputFormat) return false;
      const input = fileStatus.inputFormat;
      const output = targetFormat;

      if (['HEIC', 'JPG', 'PNG', 'TIFF'].includes(input) && ['JPG', 'PNG', 'TIFF'].includes(output)) return true;
      if (input === 'MP4' && ['MOV', 'MP3', 'WAV'].includes(output)) {
          return ffmpegLoaded; // Depends on FFmpeg being loaded
      }
      return false;
  }, [ffmpegLoaded]); // Re-evaluate when ffmpegLoaded changes

  const updateFileStatus = (id: string, updates: Partial<FileStatus>) => {
      setFilesToProcess(prevFiles =>
          prevFiles.map(fs => (fs.id === id ? { ...fs, ...updates } : fs))
      );
  };

  const removeFile = (id: string) => {
       setFilesToProcess(prevFiles => {
            const fileToRemove = prevFiles.find(fs => fs.id === id);
            if (fileToRemove?.resultUrl) {
                URL.revokeObjectURL(fileToRemove.resultUrl);
                console.log(`Revoked blob URL for removed file: ${fileToRemove.file.name}`);
            }
            return prevFiles.filter(fs => fs.id !== id);
       });
  };

  const processFiles = useCallback(async () => {
    if (!selectedOutputFormat) {
      setOverallError("Please choose an output format.");
      return;
    }

    const filesToRun = filesToProcess.filter(fs => fs.status === 'pending' && isFormatCompatible(fs, selectedOutputFormat));

    if (filesToRun.length === 0) {
      const pendingCount = filesToProcess.filter(fs => fs.status === 'pending').length;
      if (pendingCount > 0) {
        setOverallError("No pending files are compatible with the selected output format.");
      } else {
        setOverallError("No pending files to process.");
      }
      return;
    }

    // Check FFmpeg status specifically if needed for this batch
    const needsFFmpeg = filesToRun.some(fs => fs.inputFormat === 'MP4' && ['MOV', 'MP3', 'WAV'].includes(selectedOutputFormat));
    if (needsFFmpeg && !ffmpegLoaded) {
         setOverallError("FFmpeg is not ready, cannot process video/audio formats.");
         return; // Don't set isProcessing if we can't start
    }

    setIsProcessing(true);
    setOverallError(null);

    const ffmpeg = ffmpegRef.current;

    for (const fileStatus of filesToRun) { // Iterate only over compatible pending files
      // Compatibility already checked, proceed directly

      const outputFilename = `converted_${fileStatus.file.name.split('.').slice(0, -1).join('.') || fileStatus.id}.${selectedOutputFormat.toLowerCase()}`;
      updateFileStatus(fileStatus.id, {
          status: 'converting',
          outputFormat: selectedOutputFormat,
          outputFilename: outputFilename
      });

      try {
        const { file, inputFormat } = fileStatus;
        let outputBlob: Blob | null = null;

        // --- Image Conversion (heic2any or Canvas) ---
        if (inputFormat && ['HEIC', 'JPG', 'PNG', 'TIFF'].includes(inputFormat) && ['JPG', 'PNG', 'TIFF'].includes(selectedOutputFormat)) {
            const outputMimeType = selectedOutputFormat === 'JPG' ? 'image/jpeg' : `image/${selectedOutputFormat.toLowerCase()}`;
            if (inputFormat === 'HEIC') {
                console.log(`Converting HEIC ${file.name} to ${selectedOutputFormat}...`);
                const conversionResult = await heic2any({ blob: file, toType: outputMimeType, quality: 0.85 });
                outputBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
            } else { // JPG, PNG, TIFF to JPG, PNG, TIFF
                console.log(`Converting ${inputFormat} ${file.name} to ${selectedOutputFormat} using Canvas...`);
                if (selectedOutputFormat === 'TIFF') {
                    console.warn("Canvas conversion to TIFF is often unsupported by browsers. This might fail.");
                }
                outputBlob = await new Promise<Blob>((resolve, reject) => {
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
                           canvas.toBlob((blob) => {
                               if (blob) {
                                   resolve(blob);
                               } else {
                                   reject(new Error(`Canvas toBlob failed${outputMimeType === 'image/tiff' ? '. TIFF output is likely unsupported.' : '.'}`));
                               }
                           }, outputMimeType, 0.9);
                        };
                        img.onerror = (errEv) => reject(new Error(`Image could not be loaded: ${typeof errEv === 'string' ? errEv : 'Unknown image load error'}`));
                        img.src = e.target.result as string;
                    };
                    reader.onerror = () => reject(new Error(`File Reader error: ${reader.error?.message || 'Unknown read error'}`));
                    reader.readAsDataURL(file);
                });
           }
        }
        // --- Video/Audio Conversion (FFmpeg) ---
        else if (inputFormat === 'MP4' && ['MOV', 'MP3', 'WAV'].includes(selectedOutputFormat)) {
            console.log(`Converting MP4 ${file.name} to ${selectedOutputFormat} using FFmpeg...`);
            const inputFilename = `input-${fileStatus.id}.${inputFormat.toLowerCase()}`;
            const targetFilename = `output-${fileStatus.id}.${selectedOutputFormat.toLowerCase()}`;

            await ffmpeg.writeFile(inputFilename, await fetchFile(file));

            let command: string[];
            switch (selectedOutputFormat) {
                case 'MOV': command = ['-i', inputFilename, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', '+faststart', targetFilename]; break;
                case 'MP3': command = ['-i', inputFilename, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', targetFilename]; break;
                case 'WAV': command = ['-i', inputFilename, '-vn', '-acodec', 'pcm_s16le', targetFilename]; break;
                default: throw new Error('Internal error: Unsupported FFmpeg output format');
            }

            console.log("Executing FFmpeg command:", command.join(' '));
            await ffmpeg.exec(command);

            const data = await ffmpeg.readFile(targetFilename);
            outputBlob = new Blob([data], { type: selectedOutputFormat === 'MOV' ? 'video/quicktime' : (selectedOutputFormat === 'MP3' ? 'audio/mpeg' : 'audio/wav') });

            // Clean up FFmpeg filesystem for this conversion
            try {
                 await ffmpeg.deleteFile(inputFilename);
                 await ffmpeg.deleteFile(targetFilename);
                 console.log(`Cleaned FFmpeg FS for ${file.name}`);
            } catch(cleanupError) {
                console.warn(`FFmpeg cleanup failed for ${file.name}:`, cleanupError);
            }
        }
        // --- Finalize Success ---
        if (outputBlob) {
          const url = URL.createObjectURL(outputBlob);
          updateFileStatus(fileStatus.id, { status: 'done', resultUrl: url });
        } else {
          throw new Error('Conversion process did not produce an output blob.');
        }

      } catch (error) {
        console.error(`Conversion failed for ${fileStatus.file.name}:`, error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        updateFileStatus(fileStatus.id, { status: 'error', error: errorMsg });
      }
    } // End of loop

    setIsProcessing(false);
    // Check if any files *processed in this batch* ended with an error status
    const processedFileIds = filesToRun.map(f => f.id);
    if (filesToProcess.some(fs => processedFileIds.includes(fs.id) && fs.status === 'error')) {
        setOverallError("Some file conversions failed. Check individual file statuses.");
    }

  }, [filesToProcess, selectedOutputFormat, ffmpegLoaded, isFormatCompatible, updateFileStatus, setOverallError, setIsProcessing, ffmpegRef]); // Added missing dependencies

  // Calculate pending compatible files for button text
  const pendingCompatibleFileCount = filesToProcess.filter(
      fs => fs.status === 'pending' && selectedOutputFormat && isFormatCompatible(fs, selectedOutputFormat)
  ).length;
  // --- END MOVE FUNCTIONS INSIDE COMPONENT ---


  // --- JSX Return ---
  return (
    <div
        className="relative p-6 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 min-h-screen transition-colors duration-300 flex flex-col"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
    >
        {/* Drag Overlay */}
        {isDragging && (
            <div className="absolute inset-0 bg-blue-500/30 dark:bg-blue-800/30 border-4 border-dashed border-blue-600 dark:border-blue-400 rounded-lg flex items-center justify-center pointer-events-none z-50">
                <p className="text-2xl font-semibold text-blue-800 dark:text-blue-200">Drop files here</p>
            </div>
        )}

      <h1 className="text-3xl font-bold mb-6">File Converter</h1>
      <p className="text-neutral-600 dark:text-neutral-400 mb-6 text-sm">
        Convert files directly in your browser. Your files stay on your device. Supports HEIC, JPG, PNG, TIFF images and MP4 video/audio extraction.
      </p>

      {/* Overall Error Display */}
      {overallError && !isProcessing && !overallError.startsWith("Loading FFmpeg") && (
        <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-600 text-red-800 dark:text-red-300 rounded text-sm flex items-center gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>{overallError}</span>
        </div>
      )}
      {/* FFmpeg Loading Indicator */}
      {overallError?.startsWith("Loading FFmpeg") && (
         <div className="mb-4 p-3 bg-blue-100 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-600 text-blue-800 dark:text-blue-300 rounded text-sm flex items-center gap-2">
             <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
             <span>{overallError}</span>
         </div>
      )}

      <div className="flex-grow flex flex-col md:flex-row gap-6">
        {/* Left Column: Controls */}
        <div className="w-full md:w-1/3 lg:w-1/4 flex flex-col gap-4">
            <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800">
                <h2 className="text-lg font-semibold mb-3">1. Input & Format</h2>
                 {/* Reverted File Input Button Area */}
                 <div className="mb-4">
                     <label htmlFor="file-input" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"> Choose Files: </label>
                     <input
                         id="file-input"
                         type="file"
                         multiple
                         onChange={handleFileChange}
                         className="block w-full text-sm text-neutral-500 dark:text-neutral-400 file:mr-4 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-500 file:text-white hover:file:bg-blue-600 cursor-pointer border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 p-1"
                         disabled={isProcessing}
                         accept=".heic,.jpg,.jpeg,.png,.tiff,.tif,.mp4"
                     />
                     <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">HEIC, JPG, PNG, TIFF, MP4</p>
                 </div>
                 {/* End Reverted File Input Button Area */}

                <div className="mb-4">
                    <label htmlFor="output-format" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"> Convert To: </label>
                    <select
                        id="output-format"
                        value={selectedOutputFormat}
                        onChange={handleOutputFormatChange}
                        className="block w-full px-3 py-1.5 border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-700 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:focus:ring-blue-400 text-sm disabled:opacity-50"
                        disabled={isProcessing || filesToProcess.length === 0}
                    >
                        <option value="" disabled>-- Select Format --</option>
                        <optgroup label="Images">
                            <option value="JPG">JPG</option>
                            <option value="PNG">PNG</option>
                            <option value="TIFF">TIFF (May fail in browser)</option>
                        </optgroup>
                        <optgroup label="Video/Audio" disabled={!ffmpegLoaded && !overallError?.startsWith("Loading FFmpeg")}>
                            <option value="MOV" disabled={!ffmpegLoaded}>MOV (Video, H.264/AAC)</option>
                            <option value="MP3" disabled={!ffmpegLoaded}>MP3 (Audio Extract)</option>
                            <option value="WAV" disabled={!ffmpegLoaded}>WAV (Audio Extract)</option>
                        </optgroup>
                    </select>
                    {/* FFmpeg Load Failure Indicator */}
                    {!ffmpegLoaded && overallError && !overallError.startsWith("Loading FFmpeg") && (
                         <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3"/> FFmpeg failed to load. Video/audio disabled.
                         </p>
                    )}
                     {/* FFmpeg Loading Indicator near Select */}
                     {overallError?.startsWith("Loading FFmpeg") && (
                        <p className="text-xs text-blue-600 dark:text-blue-400 mt-1 flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin"/> Loading video/audio support...
                        </p>
                     )}
                </div>

                 {showFormatWarning && (
                    <div className="mb-4 p-2 bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-600 text-yellow-800 dark:text-yellow-300 rounded text-xs flex items-center gap-2">
                        <FileWarning className="w-4 h-4 flex-shrink-0" />
                        <span>Video/audio conversion uses more CPU/time.</span>
                    </div>
                 )}

                 <button
                    onClick={processFiles}
                    disabled={pendingCompatibleFileCount === 0 || !selectedOutputFormat || isProcessing}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm transition-opacity"
                 >
                    {isProcessing ? (
                        <> <Loader2 className="w-4 h-4 animate-spin" /> Processing... </>
                    ) : (
                        `Convert ${pendingCompatibleFileCount} File(s)`
                    )}
                 </button>
            </div>
        </div>

        {/* Right Column: File List & Status */}
        <div className="w-full md:w-2/3 lg:w-3/4 flex flex-col">
             <div className="p-4 border border-neutral-300 dark:border-neutral-700 rounded-md bg-neutral-50 dark:bg-neutral-800 flex-grow overflow-y-auto min-h-[200px]">
                 <h2 className="text-lg font-semibold mb-3">2. Files & Progress</h2>
                 {filesToProcess.length === 0 ? (
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 italic">Add files using the panel on the left.</p>
                 ) : (
                    <ul className="space-y-2">
                        {filesToProcess.map((fs) => {
                            // Determine compatibility within the map function based on current state
                            const isCompatible = selectedOutputFormat ? isFormatCompatible(fs, selectedOutputFormat) : false;
                            return (
                                <li key={fs.id} className={`flex items-center justify-between text-sm p-2 rounded border ${
                                    fs.status === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700/50' :
                                    fs.status === 'done' ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700/50' :
                                    fs.status === 'converting' ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700/50' :
                                    'bg-neutral-100 dark:bg-neutral-700 border-neutral-200 dark:border-neutral-600'
                                } ${(!isCompatible && fs.status === 'pending' && selectedOutputFormat) ? 'opacity-60' : ''}`}
                                >
                                    <div className="flex-1 overflow-hidden mr-2">
                                        <p className="font-medium truncate" title={fs.file.name}>{fs.file.name}</p>
                                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                            {fs.inputFormat || 'Unknown type'}
                                            {fs.outputFormat && ` -> ${fs.outputFormat}`}
                                            {` (${formatFileSize(fs.file.size)})`}
                                            {(!isCompatible && fs.status === 'pending' && selectedOutputFormat) && <span className='text-yellow-600 dark:text-yellow-400'> (Incompatible)</span>}
                                        </p>
                                        {/* Progress Indication */}
                                        {(fs.status === 'converting' || fs.status === 'done' || fs.status === 'error') && (
                                            <div className="w-full bg-neutral-200 dark:bg-neutral-600 rounded h-1 mt-1 overflow-hidden">
                                                <div
                                                    className={`h-1 rounded transition-all duration-300 ${
                                                        fs.status === 'error' ? 'bg-red-500 w-full' :
                                                        fs.status === 'done' ? 'bg-green-500 w-full' :
                                                        fs.status === 'converting' ? 'bg-blue-500 w-1/2 animate-pulse' :
                                                        'bg-transparent w-0'
                                                    }`}
                                                ></div>
                                            </div>
                                        )}
                                        {fs.status === 'error' && fs.error && (
                                            <p className='text-xs text-red-600 dark:text-red-400 mt-1 truncate' title={fs.error}>Error: {fs.error}</p>
                                        )}
                                    </div>
                                    <div className="flex items-center space-x-2 flex-shrink-0">
                                        {fs.status === 'pending' && !isCompatible && selectedOutputFormat && <span title="Incompatible for selected output"><FileWarning className="w-4 h-4 text-yellow-600 dark:text-yellow-500" /></span>}
                                        {fs.status === 'pending' && (!selectedOutputFormat || isCompatible) && <span className="text-xs text-neutral-500 dark:text-neutral-400">Ready</span>}
                                        {fs.status === 'converting' && <span title="Converting..."><Loader2 className="w-4 h-4 animate-spin text-blue-500" /></span>}
                                        {fs.status === 'done' && fs.resultUrl && (
                                            <a
                                                href={fs.resultUrl}
                                                download={fs.outputFilename || `converted_${fs.file.name}`} // Use stored output filename
                                                className="p-1 text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300 rounded hover:bg-green-100 dark:hover:bg-green-800 transition-colors"
                                                title={`Download ${fs.outputFilename}`}
                                            >
                                                <Download className="w-4 h-4" />
                                            </a>
                                        )}
                                        {fs.status === 'error' && <span title={fs.error || 'Conversion failed'}><XCircle className="w-4 h-4 text-red-500" /></span>}
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
                            )
                        })}
                    </ul>
                 )}
                 {filesToProcess.length > 0 && filesToProcess.some(fs => fs.status === 'error') && (
                     <p className="text-xs text-red-600 dark:text-red-400 mt-3">Some files failed. Check individual file status above.</p>
                 )}
             </div>
        </div>
      </div>

      {/* Optional FFmpeg Log Area (Uncomment if needed) */}
      {/* <div className="mt-4">
        <h3 className="text-sm font-semibold mb-1">FFmpeg Log (Debug)</h3>
        <textarea ref={ffmpegLogRef} readOnly className="w-full h-24 p-2 border rounded text-xs bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-600" placeholder="FFmpeg messages will appear here..." />
      </div> */}

    </div>
  );
};

export default FileConverter;