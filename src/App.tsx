/**
 * Viridian Leaf - A free PDF viewer and editor
 * Copyright (c) 2026 Viridian Intelligence Ltd. UK
 * https://github.com/coffogit/Viridian-Leaf
 * Licensed under MIT License
 */

import { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument, rgb, degrees } from "pdf-lib";
import { createWorker } from "tesseract.js";
import { open, save, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readFile, writeFile, mkdir, readDir, remove, exists } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import Icon from "@mdi/react";
import {
  mdiFileDocumentOutline,
  mdiBookmarkMultipleOutline,
  mdiTextBoxOutline,
  mdiPencil,
  mdiFormatColorHighlight,
  mdiNoteOutline,
  mdiSquare,
  mdiFormatText,
  mdiChevronLeft,
  mdiChevronRight,
  mdiClose,
  mdiPlus,
  mdiMinus,
  mdiFitToScreen,
  mdiArrowUp,
  mdiArrowDown,
} from "@mdi/js";
import "./App.css";

// Use local worker file
pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const clonePdfBytes = (bytes: Uint8Array) => new Uint8Array(bytes);

const hasPdfHeader = (bytes: Uint8Array | null) => {
  try {
    if (!bytes || bytes.length < 4) return false;

    const searchLimit = Math.min(bytes.length - 3, 1024);
    for (let i = 0; i < searchLimit; i += 1) {
      if (
        bytes[i] === 0x25 &&
        bytes[i + 1] === 0x50 &&
        bytes[i + 2] === 0x44 &&
        bytes[i + 3] === 0x46
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
};

const loadViewerDocument = (bytes: Uint8Array) =>
  pdfjsLib.getDocument({ data: clonePdfBytes(bytes) }).promise;

const loadEditablePdf = (bytes: Uint8Array) =>
  PDFDocument.load(clonePdfBytes(bytes));

interface PDFState {
  doc: pdfjsLib.PDFDocumentProxy | null;
  currentPage: number;
  totalPages: number;
  zoom: number;
  filePath: string | null;
  fileName: string | null;
}

interface RedactionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

interface TextAnnotation {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  page: number;
}

interface Signature {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

interface Highlight {
  id: string;
  rects: { x: number; y: number; width: number; height: number }[];
  color: string;
  page: number;
  text: string;
}

interface StickyNote {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  page: number;
  isOpen: boolean;
}

interface FreehandStroke {
  points: { x: number; y: number }[];
  color: string;
  width: number;
  page: number;
}

interface BookmarkItem {
  title: string;
  page: number;
  children: BookmarkItem[];
}

interface ImageAnnotation {
  id: string;
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

interface LinkAnnotation {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
  page: number;
}

interface WatermarkConfig {
  text: string;
  fontSize: number;
  color: string;
  opacity: number;
  angle: number;
  position: "center" | "diagonal" | "tile";
}

interface HeaderFooterConfig {
  headerLeft: string;
  headerCenter: string;
  headerRight: string;
  footerLeft: string;
  footerCenter: string;
  footerRight: string;
  fontSize: number;
  includePageNumbers: boolean;
  startPage: number;
  endPage: number;
}

interface CustomBookmark {
  id: string;
  title: string;
  page: number;
}

interface TabState {
  id: string;
  filePath: string | null;
  fileName: string | null;
  doc: pdfjsLib.PDFDocumentProxy | null;
  pdfBytes: Uint8Array | null;
  currentPage: number;
  totalPages: number;
  zoom: number;
  redactions: RedactionRect[];
  signatures: Signature[];
  textAnnotations: TextAnnotation[];
  highlights: Highlight[];
  stickyNotes: StickyNote[];
  freehandStrokes: FreehandStroke[];
  bookmarks: BookmarkItem[];
  thumbnails: string[];
  imageAnnotations: ImageAnnotation[];
  linkAnnotations: LinkAnnotation[];
  customBookmarks: CustomBookmark[];
}

interface SavedPosition {
  filePath: string;
  page: number;
  zoom: number;
  timestamp: number;
}

type Tool = "none" | "redact" | "screenshot" | "select" | "sign" | "text" | "highlight" | "note" | "draw" | "image" | "link";

function PDFPageView({
  doc,
  pageNum,
  zoom,
  currentTool,
  active,
  onActivate,
  onTextSelection,
}: {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNum: number;
  zoom: number;
  currentTool: Tool;
  active: boolean;
  onActivate: (pageNum: number) => void;
  onTextSelection: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const render = async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        const scale = zoom * 1.5 * window.devicePixelRatio;
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${viewport.width / window.devicePixelRatio}px`;
        canvas.style.height = `${viewport.height / window.devicePixelRatio}px`;

        context.clearRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvasContext: context,
          viewport,
          canvas,
        }).promise;

        if (cancelled || !textLayerRef.current) return;

        const textLayer = textLayerRef.current;
        textLayer.style.width = canvas.style.width;
        textLayer.style.height = canvas.style.height;
        textLayer.innerHTML = "";

        const textContent = await page.getTextContent();
        const textItems = textContent.items as any[];

        textItems.forEach((item) => {
          if (!item.str) return;

          const span = document.createElement("span");
          span.textContent = item.str;

          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const angle = Math.atan2(tx[1], tx[0]);
          const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);

          span.style.left = `${tx[4] / window.devicePixelRatio}px`;
          span.style.top = `${(tx[5] - fontHeight) / window.devicePixelRatio}px`;
          span.style.fontSize = `${fontHeight / window.devicePixelRatio}px`;
          span.style.fontFamily = "sans-serif";

          if (angle !== 0) {
            span.style.transform = `rotate(${angle}rad)`;
            span.style.transformOrigin = "left bottom";
          }

          if (item.width) {
            span.style.width = `${item.width * scale / window.devicePixelRatio}px`;
          }

          textLayer.appendChild(span);
        });
      } catch (err) {
        console.error(`Error rendering page ${pageNum}:`, err);
      }
    };

    render();
    return () => {
      cancelled = true;
    };
  }, [doc, pageNum, zoom]);

  return (
    <div
      className={`multipage-page ${active ? "active" : ""}`}
      data-page={pageNum}
      onMouseEnter={() => onActivate(pageNum)}
      onClick={() => onActivate(pageNum)}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div
        ref={textLayerRef}
        className="text-layer"
        onMouseUp={onTextSelection}
        style={{
          cursor: currentTool === "highlight" || currentTool === "select" || currentTool === "none" ? "text" : undefined,
        }}
      />
      <div className="multipage-page-number">{pageNum}</div>
    </div>
  );
}

function App() {
  // Tab management
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Get current tab helper
  const currentTab = tabs.find(t => t.id === activeTabId) || null;

  // Legacy pdf state for compatibility (points to active tab)
  const pdf: PDFState = currentTab ? {
    doc: currentTab.doc,
    currentPage: currentTab.currentPage,
    totalPages: currentTab.totalPages,
    zoom: currentTab.zoom,
    filePath: currentTab.filePath,
    fileName: currentTab.fileName,
  } : {
    doc: null,
    currentPage: 1,
    totalPages: 0,
    zoom: 1.0,
    filePath: null,
    fileName: null,
  };

  const thumbnails = currentTab?.thumbnails || [];
  const redactions = currentTab?.redactions || [];
  const signatures = currentTab?.signatures || [];
  const textAnnotations = currentTab?.textAnnotations || [];
  const highlights = currentTab?.highlights || [];
  const stickyNotes = currentTab?.stickyNotes || [];
  const freehandStrokes = currentTab?.freehandStrokes || [];
  const bookmarks = currentTab?.bookmarks || [];
  const pdfBytes = currentTab?.pdfBytes || null;
  const imageAnnotations = currentTab?.imageAnnotations || [];
  const linkAnnotations = currentTab?.linkAnnotations || [];
  const customBookmarks = currentTab?.customBookmarks || [];

  // Undo/Redo history - stored per tab
  type UndoableState = {
    redactions: RedactionRect[];
    signatures: Signature[];
    textAnnotations: TextAnnotation[];
    highlights: Highlight[];
    stickyNotes: StickyNote[];
    freehandStrokes: FreehandStroke[];
    imageAnnotations: ImageAnnotation[];
    linkAnnotations: LinkAnnotation[];
    customBookmarks: CustomBookmark[];
  };
  const [undoHistory, setUndoHistory] = useState<Map<string, UndoableState[]>>(new Map());
  const [redoHistory, setRedoHistory] = useState<Map<string, UndoableState[]>>(new Map());
  const MAX_HISTORY = 50;

  // Get current undoable state
  const getCurrentUndoableState = (): UndoableState => ({
    redactions: [...redactions],
    signatures: [...signatures],
    textAnnotations: [...textAnnotations],
    highlights: [...highlights],
    stickyNotes: [...stickyNotes],
    freehandStrokes: [...freehandStrokes],
    imageAnnotations: [...imageAnnotations],
    linkAnnotations: [...linkAnnotations],
    customBookmarks: [...customBookmarks],
  });

  // Push current state to undo history before making changes
  const pushToHistory = () => {
    if (!activeTabId) return;
    const currentState = getCurrentUndoableState();
    setUndoHistory(prev => {
      const newMap = new Map(prev);
      const tabHistory = newMap.get(activeTabId) || [];
      const newHistory = [...tabHistory, currentState].slice(-MAX_HISTORY);
      newMap.set(activeTabId, newHistory);
      return newMap;
    });
    // Clear redo history when new action is performed
    setRedoHistory(prev => {
      const newMap = new Map(prev);
      newMap.set(activeTabId, []);
      return newMap;
    });
  };

  // Undo last action
  const undo = () => {
    if (!activeTabId) return;
    const tabUndoHistory = undoHistory.get(activeTabId) || [];
    if (tabUndoHistory.length === 0) return;

    // Save current state to redo history
    const currentState = getCurrentUndoableState();
    setRedoHistory(prev => {
      const newMap = new Map(prev);
      const tabRedoHistory = newMap.get(activeTabId) || [];
      newMap.set(activeTabId, [...tabRedoHistory, currentState]);
      return newMap;
    });

    // Pop and restore from undo history
    const previousState = tabUndoHistory[tabUndoHistory.length - 1];
    setUndoHistory(prev => {
      const newMap = new Map(prev);
      newMap.set(activeTabId, tabUndoHistory.slice(0, -1));
      return newMap;
    });

    // Restore the state
    setTabs(prev => prev.map(tab =>
      tab.id === activeTabId ? {
        ...tab,
        redactions: previousState.redactions,
        signatures: previousState.signatures,
        textAnnotations: previousState.textAnnotations,
        highlights: previousState.highlights,
        stickyNotes: previousState.stickyNotes,
        freehandStrokes: previousState.freehandStrokes,
        imageAnnotations: previousState.imageAnnotations,
        linkAnnotations: previousState.linkAnnotations,
        customBookmarks: previousState.customBookmarks,
      } : tab
    ));
  };

  // Redo last undone action
  const redo = () => {
    if (!activeTabId) return;
    const tabRedoHistory = redoHistory.get(activeTabId) || [];
    if (tabRedoHistory.length === 0) return;

    // Save current state to undo history
    const currentState = getCurrentUndoableState();
    setUndoHistory(prev => {
      const newMap = new Map(prev);
      const tabUndoHistory = newMap.get(activeTabId) || [];
      newMap.set(activeTabId, [...tabUndoHistory, currentState]);
      return newMap;
    });

    // Pop and restore from redo history
    const nextState = tabRedoHistory[tabRedoHistory.length - 1];
    setRedoHistory(prev => {
      const newMap = new Map(prev);
      newMap.set(activeTabId, tabRedoHistory.slice(0, -1));
      return newMap;
    });

    // Restore the state
    setTabs(prev => prev.map(tab =>
      tab.id === activeTabId ? {
        ...tab,
        redactions: nextState.redactions,
        signatures: nextState.signatures,
        textAnnotations: nextState.textAnnotations,
        highlights: nextState.highlights,
        stickyNotes: nextState.stickyNotes,
        freehandStrokes: nextState.freehandStrokes,
        imageAnnotations: nextState.imageAnnotations,
        linkAnnotations: nextState.linkAnnotations,
        customBookmarks: nextState.customBookmarks,
      } : tab
    ));
  };

  // Check if undo/redo is available
  const canUndo = activeTabId ? (undoHistory.get(activeTabId)?.length || 0) > 0 : false;
  const canRedo = activeTabId ? (redoHistory.get(activeTabId)?.length || 0) > 0 : false;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [currentTool, setCurrentTool] = useState<Tool>("none");
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [selectedText, setSelectedText] = useState<string>("");
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrText, setOcrText] = useState<string>("");
  const [showOcrResult, setShowOcrResult] = useState(false);
  const [viewMode, setViewMode] = useState<"single" | "two-page" | "continuous">("continuous");
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [savedPositions, setSavedPositions] = useState<SavedPosition[]>([]);
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeFiles, setMergeFiles] = useState<string[]>([]);
  const [draggedMergeIndex, setDraggedMergeIndex] = useState<number | null>(null);

  // Sidebar mode: thumbnails, bookmarks, annotations
  const [sidebarMode, setSidebarMode] = useState<"thumbnails" | "bookmarks" | "annotations">("thumbnails");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Highlight color
  const [highlightColor, setHighlightColor] = useState("#ffff00");

  // Sticky note color
  const [noteColor, _setNoteColor] = useState("#ffffa0");

  // Drawing settings
  const [drawColor, setDrawColor] = useState("#000000");
  const [drawWidth, setDrawWidth] = useState(2);
  const [currentStroke, setCurrentStroke] = useState<{ x: number; y: number }[]>([]);

  // Text-to-Speech
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [_speechUtterance, setSpeechUtterance] = useState<SpeechSynthesisUtterance | null>(null);

  // Invert PDF colors (true dark mode)
  const [_invertPdfColors, _setInvertPdfColors] = useState(false);

  // Search case sensitivity
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);

  // Watermark modal
  const [showWatermarkModal, setShowWatermarkModal] = useState(false);
  const [watermarkConfig, setWatermarkConfig] = useState<WatermarkConfig>({
    text: "CONFIDENTIAL",
    fontSize: 48,
    color: "#888888",
    opacity: 0.3,
    angle: -45,
    position: "diagonal",
  });

  // Header/Footer modal
  const [showHeaderFooterModal, setShowHeaderFooterModal] = useState(false);
  const [headerFooterConfig, setHeaderFooterConfig] = useState<HeaderFooterConfig>({
    headerLeft: "",
    headerCenter: "",
    headerRight: "",
    footerLeft: "",
    footerCenter: "",
    footerRight: "",
    fontSize: 10,
    includePageNumbers: true,
    startPage: 1,
    endPage: 0,
  });

  // Bookmark modal
  const [showBookmarkModal, setShowBookmarkModal] = useState(false);
  const [newBookmarkTitle, setNewBookmarkTitle] = useState("");

  // Link creation
  const [pendingLinkRect, setPendingLinkRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [_showLinkModal, setShowLinkModal] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState("");

  // Image insertion
  const [pendingImage, setPendingImage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const _drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const [_appDataPath, setAppDataPath] = useState<string>("");

  // Tab update helper - updates the active tab's state
  const updateCurrentTab = useCallback((updates: Partial<TabState>) => {
    if (!activeTabId) return;
    setTabs(prev => prev.map(tab =>
      tab.id === activeTabId ? { ...tab, ...updates } : tab
    ));
  }, [activeTabId]);

  const getPdfBytesForSave = async () => {
    if (hasPdfHeader(pdfBytes)) {
      return clonePdfBytes(pdfBytes!);
    }

    if (pdf.filePath) {
      const fileData = await readFile(pdf.filePath);
      const bytes = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
      if (hasPdfHeader(bytes)) {
        const savedBytes = clonePdfBytes(bytes);
        updateCurrentTab({ pdfBytes: savedBytes });
        return clonePdfBytes(savedBytes);
      }
    }

    throw new Error("Current PDF data is unavailable. Reopen the PDF and try again.");
  };

  // Create new tab
  const createTab = (fileData?: {
    filePath: string;
    fileName: string;
    doc: pdfjsLib.PDFDocumentProxy;
    pdfBytes: Uint8Array;
    bookmarks: BookmarkItem[];
    thumbnails: string[];
    totalPages: number;
    initialPage?: number;
    initialZoom?: number;
  }) => {
    const id = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newTab: TabState = {
      id,
      filePath: fileData?.filePath || null,
      fileName: fileData?.fileName || null,
      doc: fileData?.doc || null,
      pdfBytes: fileData?.pdfBytes || null,
      currentPage: fileData?.initialPage || 1,
      totalPages: fileData?.totalPages || 0,
      zoom: fileData?.initialZoom || 1.0,
      redactions: [],
      signatures: [],
      textAnnotations: [],
      highlights: [],
      stickyNotes: [],
      freehandStrokes: [],
      bookmarks: fileData?.bookmarks || [],
      thumbnails: fileData?.thumbnails || [],
      imageAnnotations: [],
      linkAnnotations: [],
      customBookmarks: [],
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(id);
    return id;
  };

  // Close tab
  const closeTab = (tabId: string) => {
    setTabs(prev => {
      const newTabs = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      } else if (newTabs.length === 0) {
        setActiveTabId(null);
      }
      return newTabs;
    });
  };

  // Extract bookmarks from PDF
  const extractBookmarks = async (doc: pdfjsLib.PDFDocumentProxy): Promise<BookmarkItem[]> => {
    try {
      const outline = await doc.getOutline();
      if (!outline) return [];

      const processOutlineItems = async (items: any[]): Promise<BookmarkItem[]> => {
        const result: BookmarkItem[] = [];
        for (const item of items) {
          let pageNum = 1;
          if (item.dest) {
            try {
              const dest = typeof item.dest === 'string'
                ? await doc.getDestination(item.dest)
                : item.dest;
              if (dest) {
                const pageIndex = await doc.getPageIndex(dest[0]);
                pageNum = pageIndex + 1;
              }
            } catch (e) {
              console.warn('Could not resolve bookmark destination:', e);
            }
          }
          const children = item.items ? await processOutlineItems(item.items) : [];
          result.push({
            title: item.title || 'Untitled',
            page: pageNum,
            children,
          });
        }
        return result;
      };

      return await processOutlineItems(outline);
    } catch (err) {
      console.error('Error extracting bookmarks:', err);
      return [];
    }
  };

  // Smart text copy - clean up line breaks
  const smartCopyText = (text: string): string => {
    return text
      .replace(/([a-z,;:])\n([a-z])/gi, '$1 $2')
      .replace(/([a-z])-\n([a-z])/gi, '$1$2')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  // Text-to-Speech functions
  const startSpeaking = async () => {
    if (!pdf.doc || isSpeaking) return;

    try {
      let textToRead = selectedText.trim();

      if (!textToRead) {
        const page = await pdf.doc.getPage(pdf.currentPage);
        const textContent = await page.getTextContent();
        textToRead = textContent.items.map((item: any) => item.str).join(' ');
      }

      if (!textToRead) return;

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(textToRead);
      utterance.rate = 1.0;
      utterance.onend = () => {
        setIsSpeaking(false);
        setSpeechUtterance(null);
      };
      utterance.onerror = () => {
        setIsSpeaking(false);
        setSpeechUtterance(null);
      };

      window.speechSynthesis.speak(utterance);
      setSpeechUtterance(utterance);
      setIsSpeaking(true);
    } catch (err) {
      console.error('Error starting speech:', err);
    }
  };

  const stopSpeaking = () => {
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setSpeechUtterance(null);
  };

  const toggleSpeaking = () => {
    if (isSpeaking) {
      stopSpeaking();
    } else {
      startSpeaking();
    }
  };

  // Save position for a file
  const savePosition = async (filePath: string, page: number, zoom: number) => {
    const newPositions = savedPositions.filter(p => p.filePath !== filePath);
    newPositions.push({ filePath, page, zoom, timestamp: Date.now() });
    const trimmed = newPositions.slice(-50);
    setSavedPositions(trimmed);

    try {
      const dataDir = await appDataDir();
      const posPath = await join(dataDir, 'positions.json');
      const encoder = new TextEncoder();
      await writeFile(posPath, encoder.encode(JSON.stringify(trimmed)));
    } catch (err) {
      console.error('Error saving position:', err);
    }
  };

  // Get saved position for a file
  const getSavedPosition = (filePath: string): SavedPosition | null => {
    return savedPositions.find(p => p.filePath === filePath) || null;
  };

  // Initialize app data directory and load saved data
  useEffect(() => {
    const initAppData = async () => {
      try {
        const dataDir = await appDataDir();
        setAppDataPath(dataDir);

        // Create signatures directory if needed
        const sigDir = await join(dataDir, "signatures");
        if (!(await exists(sigDir))) {
          await mkdir(sigDir, { recursive: true });
        }

        // Load saved signatures
        const sigFiles = await readDir(sigDir);
        const sigs: string[] = [];
        for (const file of sigFiles) {
          if (file.name?.endsWith(".png")) {
            const filePath = await join(sigDir, file.name);
            const data = await readFile(filePath);
            const blob = new Blob([data], { type: "image/png" });
            const dataUrl = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
            sigs.push(dataUrl);
          }
        }
        setSavedSignatures(sigs);

        // Load recent files
        const recentPath = await join(dataDir, "recent-files.json");
        if (await exists(recentPath)) {
          const data = await readFile(recentPath);
          const text = new TextDecoder().decode(data);
          setRecentFiles(JSON.parse(text));
        }

        // Load saved positions
        const posPath = await join(dataDir, "positions.json");
        if (await exists(posPath)) {
          const data = await readFile(posPath);
          const text = new TextDecoder().decode(data);
          setSavedPositions(JSON.parse(text));
        }
      } catch (err) {
        console.error("Error initializing app data:", err);
      }
    };

    initAppData();
  }, []);

  // Render PDF page
  const _renderPage = useCallback(async (pageNum: number, zoomLevel: number) => {
    if (!pdf.doc || !canvasRef.current) return;

    try {
      const page = await pdf.doc.getPage(pageNum);
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;

      const scale = zoomLevel * 1.5 * window.devicePixelRatio;
      const viewport = page.getViewport({ scale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / window.devicePixelRatio}px`;
      canvas.style.height = `${viewport.height / window.devicePixelRatio}px`;

      // Clear and render
      context.clearRect(0, 0, canvas.width, canvas.height);

      const renderContext = {
        canvasContext: context,
        viewport: viewport,
        canvas: canvas,
      };

      await page.render(renderContext).promise;

      // Setup overlay canvas for redactions
      if (overlayCanvasRef.current) {
        overlayCanvasRef.current.width = canvas.width;
        overlayCanvasRef.current.height = canvas.height;
        overlayCanvasRef.current.style.width = canvas.style.width;
        overlayCanvasRef.current.style.height = canvas.style.height;
        drawRedactions();
      }

      // Render text layer for selection
      if (textLayerRef.current) {
        const displayWidth = viewport.width / window.devicePixelRatio;
        const displayHeight = viewport.height / window.devicePixelRatio;

        textLayerRef.current.style.width = `${displayWidth}px`;
        textLayerRef.current.style.height = `${displayHeight}px`;
        textLayerRef.current.innerHTML = "";

        const textContent = await page.getTextContent();
        const textItems = textContent.items as any[];

        textItems.forEach((item) => {
          if (!item.str) return;
          const span = document.createElement("span");
          span.textContent = item.str;

          // Get transform matrix for this text item
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);

          // Calculate position and size
          const angle = Math.atan2(tx[1], tx[0]);
          const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          const fontAscent = fontHeight;

          span.style.left = `${tx[4] / window.devicePixelRatio}px`;
          span.style.top = `${(tx[5] - fontAscent) / window.devicePixelRatio}px`;
          span.style.fontSize = `${fontHeight / window.devicePixelRatio}px`;
          span.style.fontFamily = "sans-serif";

          if (angle !== 0) {
            span.style.transform = `rotate(${angle}rad)`;
            span.style.transformOrigin = "left bottom";
          }

          // Set width based on text width from PDF
          if (item.width) {
            span.style.width = `${item.width * scale / window.devicePixelRatio}px`;
          }

          textLayerRef.current?.appendChild(span);
        });
      }
    } catch (err) {
      console.error("Error rendering page:", err);
    }
  }, [pdf.doc]);

  // Draw redaction rectangles
  const drawRedactions = useCallback(() => {
    if (!overlayCanvasRef.current) return;
    const ctx = overlayCanvasRef.current.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, overlayCanvasRef.current.width, overlayCanvasRef.current.height);

    const pageRedactions = redactions.filter(r => r.page === pdf.currentPage);
    ctx.fillStyle = "rgba(0, 0, 0, 1)";

    pageRedactions.forEach(rect => {
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    });
  }, [redactions, pdf.currentPage]);

  useEffect(() => {
    if (viewMode === "single" && !isLoading && pdf.doc && canvasRef.current) {
      const doRender = async () => {
        try {
          const page = await pdf.doc!.getPage(pdf.currentPage);
          const canvas = canvasRef.current;
          if (!canvas) return;
          const context = canvas.getContext("2d");
          if (!context) return;

          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;
          const viewport = page.getViewport({ scale });

          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / window.devicePixelRatio}px`;
          canvas.style.height = `${viewport.height / window.devicePixelRatio}px`;

          context.clearRect(0, 0, canvas.width, canvas.height);

          await page.render({
            canvasContext: context,
            viewport: viewport,
            canvas: canvas,
          }).promise;

          // Setup overlay canvas
          if (overlayCanvasRef.current) {
            overlayCanvasRef.current.width = canvas.width;
            overlayCanvasRef.current.height = canvas.height;
            overlayCanvasRef.current.style.width = canvas.style.width;
            overlayCanvasRef.current.style.height = canvas.style.height;
          }

          // Render text layer
          if (textLayerRef.current) {
            const displayWidth = viewport.width / window.devicePixelRatio;
            const displayHeight = viewport.height / window.devicePixelRatio;

            textLayerRef.current.style.width = `${displayWidth}px`;
            textLayerRef.current.style.height = `${displayHeight}px`;
            textLayerRef.current.innerHTML = "";

            const textContent = await page.getTextContent();
            const textItems = textContent.items as any[];

            textItems.forEach((item) => {
              if (!item.str) return;
              const span = document.createElement("span");
              span.textContent = item.str;

              const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
              const angle = Math.atan2(tx[1], tx[0]);
              const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
              const fontAscent = fontHeight;

              span.style.left = `${tx[4] / window.devicePixelRatio}px`;
              span.style.top = `${(tx[5] - fontAscent) / window.devicePixelRatio}px`;
              span.style.fontSize = `${fontHeight / window.devicePixelRatio}px`;
              span.style.fontFamily = "sans-serif";

              if (angle !== 0) {
                span.style.transform = `rotate(${angle}rad)`;
                span.style.transformOrigin = "left bottom";
              }

              if (item.width) {
                span.style.width = `${item.width * scale / window.devicePixelRatio}px`;
              }

              textLayerRef.current?.appendChild(span);
            });
          }
        } catch (err) {
          console.error("Error rendering page:", err);
        }
      };

      const timer = setTimeout(doRender, 50);
      return () => clearTimeout(timer);
    }
  }, [pdf.currentPage, pdf.zoom, pdf.doc, isLoading, viewMode]);

  useEffect(() => {
    drawRedactions();
  }, [redactions, drawRedactions]);

  // Open PDF file (in new tab)
  const openFile = async (inNewTab = true) => {
    try {
      setError(null);
      setActiveMenu(null);

      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });

      if (selected) {
        setIsLoading(true);

        // Clear canvas for loading indicator
        if (textLayerRef.current) {
          textLayerRef.current.innerHTML = "";
        }
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }

        const fileData = await readFile(selected);
        const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
        const savedBytes = clonePdfBytes(data);

        const doc = await loadViewerDocument(data);

        // Extract bookmarks
        const extractedBookmarks = await extractBookmarks(doc);

        // Generate thumbnails
        const thumbs = await generateThumbnailsForDoc(doc);

        // Get saved position
        const savedPos = getSavedPosition(selected);
        const initialPage = savedPos?.page || 1;
        const initialZoom = savedPos?.zoom || 1.0;

        // Create new tab or update current
        if (inNewTab || tabs.length === 0) {
          createTab({
            filePath: selected,
            fileName: selected.split(/[/\\]/).pop() || "document.pdf",
            doc,
            pdfBytes: savedBytes,
            bookmarks: extractedBookmarks,
            thumbnails: thumbs,
            totalPages: doc.numPages,
            initialPage,
            initialZoom,
          });
        } else {
          updateCurrentTab({
            filePath: selected,
            fileName: selected.split(/[/\\]/).pop() || "document.pdf",
            doc,
            pdfBytes: savedBytes,
            currentPage: initialPage,
            totalPages: doc.numPages,
            zoom: initialZoom,
            redactions: [],
            signatures: [],
            textAnnotations: [],
            highlights: [],
            stickyNotes: [],
            freehandStrokes: [],
            bookmarks: extractedBookmarks,
            thumbnails: thumbs,
          });
        }

        addToRecentFiles(selected);
        setIsLoading(false);
      }
    } catch (err) {
      console.error("Error opening file:", err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }
  };

  // Generate thumbnails for a document
  const generateThumbnailsForDoc = async (doc: pdfjsLib.PDFDocumentProxy): Promise<string[]> => {
    const thumbs: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 0.2 });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) continue;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport: viewport,
          canvas: canvas,
        }).promise;

        thumbs.push(canvas.toDataURL());
      } catch (err) {
        console.error(`Error generating thumbnail for page ${i}:`, err);
        thumbs.push("");
      }
    }
    return thumbs;
  };

  // Export current page to image
  const exportToImage = async (format: "png" | "jpeg") => {
    if (!pdf.doc) return;
    setActiveMenu(null);

    try {
      const ext = format === "jpeg" ? "jpg" : "png";
      const savePath = await save({
        filters: [{ name: `${format.toUpperCase()} Image`, extensions: [ext] }],
        defaultPath: `${pdf.fileName?.replace(".pdf", "")}_page${pdf.currentPage}.${ext}`,
      });

      if (savePath) {
        const page = await pdf.doc.getPage(pdf.currentPage);
        const scale = 3.0; // High quality export
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport: viewport,
          canvas: canvas,
        }).promise;

        // Apply redactions
        const pageRedactions = redactions.filter(r => r.page === pdf.currentPage);
        context.fillStyle = "black";
        pageRedactions.forEach(rect => {
          const scaleFactor = scale / (pdf.zoom * 1.5 * window.devicePixelRatio);
          context.fillRect(
            rect.x * scaleFactor,
            rect.y * scaleFactor,
            rect.width * scaleFactor,
            rect.height * scaleFactor
          );
        });

        const dataUrl = canvas.toDataURL(`image/${format}`, 0.95);
        const base64Data = dataUrl.split(",")[1];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        await writeFile(savePath, binaryData);

        await message(`Exported page ${pdf.currentPage} to ${savePath}`, { title: "Export Complete" });
      }
    } catch (err) {
      console.error("Error exporting:", err);
      await message(`Export failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Export all pages to images
  const exportAllPages = async (format: "png" | "jpeg") => {
    if (!pdf.doc) return;
    setActiveMenu(null);

    try {
      const folder = await open({
        directory: true,
        title: "Select folder for exported images",
      });

      if (folder) {
        const ext = format === "jpeg" ? "jpg" : "png";
        const baseName = pdf.fileName?.replace(".pdf", "") || "page";

        for (let i = 1; i <= pdf.totalPages; i++) {
          const page = await pdf.doc.getPage(i);
          const scale = 2.0;
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) continue;

          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({
            canvasContext: context,
            viewport: viewport,
            canvas: canvas,
          }).promise;

          // Apply redactions
          const pageRedactions = redactions.filter(r => r.page === i);
          context.fillStyle = "black";
          pageRedactions.forEach(rect => {
            const scaleFactor = scale / (pdf.zoom * 1.5 * window.devicePixelRatio);
            context.fillRect(
              rect.x * scaleFactor,
              rect.y * scaleFactor,
              rect.width * scaleFactor,
              rect.height * scaleFactor
            );
          });

          const dataUrl = canvas.toDataURL(`image/${format}`, 0.95);
          const base64Data = dataUrl.split(",")[1];
          const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

          const filePath = `${folder}/${baseName}_${String(i).padStart(3, "0")}.${ext}`;
          await writeFile(filePath, binaryData);
        }

        await message(`Exported ${pdf.totalPages} pages to ${folder}`, { title: "Export Complete" });
      }
    } catch (err) {
      console.error("Error exporting:", err);
      await message(`Export failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Merge PDFs
  const mergePDFs = async () => {
    setActiveMenu(null);

    try {
      const files = await open({
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        title: "Select PDFs to merge",
      });

      if (files && Array.isArray(files) && files.length >= 2) {
        setMergeFiles(files);
        setShowMergeModal(true);
      } else if (files) {
        await message("Please select at least 2 PDF files to merge.", { title: "Merge PDFs" });
      }
    } catch (err) {
      console.error("Error selecting PDFs:", err);
      await message(`Error: ${err}`, { title: "Error", kind: "error" });
    }
  };

  const executeMerge = async () => {
    if (mergeFiles.length < 2) return;

    try {
      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: "merged.pdf",
      });

      if (savePath) {
        const mergedPdf = await PDFDocument.create();

        for (const filePath of mergeFiles) {
          const fileData = await readFile(filePath);
          const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
          const pdfDoc = await PDFDocument.load(data);
          const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
          copiedPages.forEach((page) => mergedPdf.addPage(page));
        }

        const mergedBytes = await mergedPdf.save();
        await writeFile(savePath, mergedBytes);
        setShowMergeModal(false);
        setMergeFiles([]);
        await message(`Merged ${mergeFiles.length} PDFs into ${savePath}`, { title: "Merge Complete" });
      }
    } catch (err) {
      console.error("Error merging PDFs:", err);
      await message(`Merge failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  const moveMergeFile = (fromIndex: number, toIndex: number) => {
    const newFiles = [...mergeFiles];
    const [removed] = newFiles.splice(fromIndex, 1);
    newFiles.splice(toIndex, 0, removed);
    setMergeFiles(newFiles);
  };

  const removeMergeFile = (index: number) => {
    setMergeFiles(mergeFiles.filter((_, i) => i !== index));
  };

  const addMoreMergeFiles = async () => {
    try {
      const files = await open({
        multiple: true,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        title: "Add more PDFs",
      });

      if (files && Array.isArray(files)) {
        setMergeFiles([...mergeFiles, ...files]);
      }
    } catch (err) {
      console.error("Error adding files:", err);
    }
  };

  // Print PDF
  const printPDF = () => {
    setActiveMenu(null);
    window.print();
  };

  // Screenshot area of the page
  const _takeScreenshot = async () => {
    if (!canvasRef.current || !isDrawing || !drawStart) return;

    const rect = overlayCanvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // This will be captured when the user finishes drawing in screenshot mode
  };

  // Handle screenshot save
  const _saveScreenshot = async (x: number, y: number, width: number, height: number) => {
    if (!canvasRef.current) return;

    try {
      const savePath = await save({
        filters: [{ name: "PNG Image", extensions: ["png"] }],
        defaultPath: `screenshot_${Date.now()}.png`,
      });

      if (savePath) {
        // Create a new canvas for the screenshot
        const screenshotCanvas = document.createElement("canvas");
        const ctx = screenshotCanvas.getContext("2d");
        if (!ctx) return;

        screenshotCanvas.width = width;
        screenshotCanvas.height = height;

        // Draw the selected portion
        ctx.drawImage(
          canvasRef.current,
          x, y, width, height,
          0, 0, width, height
        );

        const dataUrl = screenshotCanvas.toDataURL("image/png");
        const base64Data = dataUrl.split(",")[1];
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        await writeFile(savePath, binaryData);

        await message(`Screenshot saved to ${savePath}`, { title: "Screenshot Saved" });
      }
    } catch (err) {
      console.error("Error saving screenshot:", err);
    }
  };

  // Copy page as image to clipboard (for screenshot tool)
  const copyToClipboard = async () => {
    if (!canvasRef.current) return;
    setActiveMenu(null);

    try {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const base64Data = dataUrl.split(",")[1];
      const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const blob = new Blob([binaryData], { type: "image/png" });

      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);

      await message("Page copied to clipboard as image", { title: "Copied" });
    } catch (err) {
      console.error("Error copying to clipboard:", err);
      await message("Could not copy to clipboard. Try using Export instead.", { title: "Copy Failed", kind: "error" });
    }
  };

  // Recent files management
  const addToRecentFiles = async (filePath: string) => {
    const filtered = recentFiles.filter(f => f !== filePath);
    const updated = [filePath, ...filtered].slice(0, 4);
    setRecentFiles(updated);

    // Save to app data
    try {
      const dataDir = await appDataDir();
      const recentPath = await join(dataDir, "recent-files.json");
      const encoder = new TextEncoder();
      await writeFile(recentPath, encoder.encode(JSON.stringify(updated)));
    } catch (err) {
      console.error("Error saving recent files:", err);
    }
  };

  const clearRecentFiles = async () => {
    setRecentFiles([]);
    setActiveMenu(null);

    try {
      const dataDir = await appDataDir();
      const recentPath = await join(dataDir, "recent-files.json");
      if (await exists(recentPath)) {
        await remove(recentPath);
      }
    } catch (err) {
      console.error("Error clearing recent files:", err);
    }
  };

  const openRecentFile = async (filePath: string) => {
    setActiveMenu(null);
    try {
      setIsLoading(true);

      // Clear canvas for loading
      if (textLayerRef.current) {
        textLayerRef.current.innerHTML = "";
      }
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }

      const fileData = await readFile(filePath);
      const data = fileData instanceof Uint8Array ? fileData : new Uint8Array(fileData);
      const savedBytes = clonePdfBytes(data);

      const doc = await loadViewerDocument(data);

      // Extract bookmarks
      const extractedBookmarks = await extractBookmarks(doc);

      // Generate thumbnails
      const thumbs = await generateThumbnailsForDoc(doc);

      // Get saved position
      const savedPos = getSavedPosition(filePath);
      const initialPage = savedPos?.page || 1;
      const initialZoom = savedPos?.zoom || 1.0;

      // Create new tab
      createTab({
        filePath,
        fileName: filePath.split(/[/\\]/).pop() || "document.pdf",
        doc,
        pdfBytes: savedBytes,
        bookmarks: extractedBookmarks,
        thumbnails: thumbs,
        totalPages: doc.numPages,
        initialPage,
        initialZoom,
      });

      addToRecentFiles(filePath);
      setIsLoading(false);
    } catch (err) {
      console.error("Error opening recent file:", err);
      setError(err instanceof Error ? err.message : String(err));
      setIsLoading(false);
    }
  };

  // Listen for file open events from OS (double-click on PDF)
  useEffect(() => {
    const unlisten = listen<string>("open-file", (event) => {
      const filePath = event.payload;
      if (filePath && filePath.toLowerCase().endsWith(".pdf")) {
        openRecentFile(filePath);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Save PDF with redactions burned in
  const _saveRedactedPDF = async () => {
    if (redactions.length === 0) return;
    setActiveMenu(null);

    try {
      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: pdf.fileName?.replace(".pdf", "_redacted.pdf") || "redacted.pdf",
      });

      if (savePath) {
        const sourceBytes = await getPdfBytesForSave();
        const pdfDoc = await loadEditablePdf(sourceBytes);
        const pages = pdfDoc.getPages();

        for (const redaction of redactions) {
          const page = pages[redaction.page - 1];
          if (!page) continue;

          const { width: pageWidth, height: pageHeight } = page.getSize();
          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;

          const x = (redaction.x / scale) * (pageWidth / (canvasRef.current?.width || 1) * scale);
          const y = pageHeight - ((redaction.y + redaction.height) / scale) * (pageHeight / (canvasRef.current?.height || 1) * scale);
          const w = (redaction.width / scale) * (pageWidth / (canvasRef.current?.width || 1) * scale);
          const h = (redaction.height / scale) * (pageHeight / (canvasRef.current?.height || 1) * scale);

          page.drawRectangle({
            x: x,
            y: y,
            width: w,
            height: h,
            color: rgb(0, 0, 0),
          });
        }

        const modifiedPdfBytes = await pdfDoc.save();
        await writeFile(savePath, modifiedPdfBytes);
        await message(`Saved redacted PDF to ${savePath}`, { title: "Save Complete" });
      }
    } catch (err) {
      console.error("Error saving redacted PDF:", err);
      await message(`Save failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Run OCR on current page
  const runOCR = async () => {
    if (!canvasRef.current) return;
    setActiveMenu(null);
    setIsOcrRunning(true);

    try {
      const worker = await createWorker("eng");
      const dataUrl = canvasRef.current.toDataURL("image/png");
      const { data: { text } } = await worker.recognize(dataUrl);
      await worker.terminate();

      setOcrText(text);
      setShowOcrResult(true);
    } catch (err) {
      console.error("OCR error:", err);
      await message(`OCR failed: ${err}`, { title: "Error", kind: "error" });
    } finally {
      setIsOcrRunning(false);
    }
  };

  // Copy selected text to clipboard
  const copySelectedText = async () => {
    if (!selectedText) return;
    try {
      await navigator.clipboard.writeText(selectedText);
      await message("Text copied to clipboard", { title: "Copied" });
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  // Handle text selection from text layer
  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      const rawText = selection.toString();
      const cleanedText = smartCopyText(rawText);
      setSelectedText(cleanedText);

      // If highlight tool is active, create a highlight
      if (currentTool === "highlight" && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const rects = Array.from(range.getClientRects()).map(r => {
          const containerRect = textLayerRef.current?.getBoundingClientRect();
          if (!containerRect) return { x: 0, y: 0, width: 0, height: 0 };
          return {
            x: r.left - containerRect.left,
            y: r.top - containerRect.top,
            width: r.width,
            height: r.height,
          };
        }).filter(r => r.width > 0 && r.height > 0);

        if (rects.length > 0) {
          addHighlight(rects, cleanedText);
          selection.removeAllRanges();
        }
      }
    }
  };

  // Find text in PDF
  const findTextInPDF = async () => {
    if (!pdf.doc || !searchText.trim()) return;

    const results: { page: number; text: string; matchText: string }[] = [];
    const searchFor = searchCaseSensitive ? searchText : searchText.toLowerCase();

    for (let i = 1; i <= pdf.totalPages; i++) {
      const page = await pdf.doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      const compareText = searchCaseSensitive ? pageText : pageText.toLowerCase();

      // Build regex for whole word matching if needed
      let matches: { index: number; text: string }[] = [];
      if (searchWholeWord) {
        const escaped = searchFor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, searchCaseSensitive ? 'g' : 'gi');
        let match;
        while ((match = regex.exec(pageText)) !== null) {
          matches.push({ index: match.index, text: match[0] });
        }
      } else {
        let idx = compareText.indexOf(searchFor);
        while (idx !== -1) {
          matches.push({ index: idx, text: pageText.slice(idx, idx + searchText.length) });
          idx = compareText.indexOf(searchFor, idx + 1);
        }
      }

      // Add each match as a result with context
      for (const m of matches) {
        const start = Math.max(0, m.index - 30);
        const end = Math.min(pageText.length, m.index + searchText.length + 30);
        const context = (start > 0 ? "..." : "") + pageText.slice(start, end) + (end < pageText.length ? "..." : "");
        results.push({ page: i, text: context, matchText: m.text });
      }
    }

    setSearchResults(results);
    setCurrentSearchIndex(0);

    if (results.length > 0) {
      goToSearchResult(0, results);
    }
  };

  // Scroll to and highlight a search result
  const goToSearchResult = async (index: number, results = searchResults) => {
    const result = results[index];
    if (!result || !pdf.doc) return;

    // Navigate to the page first
    if (pdf.currentPage !== result.page) {
      goToPage(result.page);
      // Wait for page to render
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Find and scroll to the matching text in the text layer
    const textLayer = textLayerRef.current;
    if (!textLayer) return;

    const spans = textLayer.querySelectorAll('span');
    const searchLower = result.matchText.toLowerCase();

    // Remove any previous search highlights
    document.querySelectorAll('.search-highlight-active').forEach(el => {
      el.classList.remove('search-highlight-active');
    });

    for (const span of spans) {
      const spanText = span.textContent || '';
      if (spanText.toLowerCase().includes(searchLower)) {
        // Add highlight class and scroll into view
        span.classList.add('search-highlight-active');
        span.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        break;
      }
    }
  };

  const goToNextResult = () => {
    if (searchResults.length === 0) return;
    const next = (currentSearchIndex + 1) % searchResults.length;
    setCurrentSearchIndex(next);
    goToSearchResult(next);
  };

  const goToPrevResult = () => {
    if (searchResults.length === 0) return;
    const prev = (currentSearchIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentSearchIndex(prev);
    goToSearchResult(prev);
  };

  const closeFindBar = () => {
    setShowFindBar(false);
    setSearchText("");
    setSearchResults([]);
  };

  // Signature state
  const [isSignatureDrawing, setIsSignatureDrawing] = useState(false);
  const [savedSignatures, setSavedSignatures] = useState<string[]>([]);
  const [draggingSignature, setDraggingSignature] = useState<number | null>(null);
  const [signatureDragOffset, setSignatureDragOffset] = useState({ x: 0, y: 0 });
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [editingTextIndex, setEditingTextIndex] = useState<number | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [showCropModal, setShowCropModal] = useState(false);
  const [showFindBar, setShowFindBar] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<{ page: number; text: string; matchText: string }[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropRect, setCropRect] = useState({ x: 0, y: 0, width: 200, height: 80 });
  const [isCropping, setIsCropping] = useState(false);
  const [cropStart, setCropStart] = useState({ x: 0, y: 0 });
  const [cropImageBounds, setCropImageBounds] = useState({ x: 0, y: 0, width: 0, height: 0, scale: 1 });
  const cropCanvasRef = useRef<HTMLCanvasElement>(null);

  // Signature pad functions
  const startSignature = () => {
    setShowSignaturePad(true);
    setActiveMenu(null);
    setTimeout(() => {
      if (signatureCanvasRef.current) {
        const ctx = signatureCanvasRef.current.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, signatureCanvasRef.current.width, signatureCanvasRef.current.height);
        }
      }
    }, 100);
  };

  const handleSignatureDrawStart = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsSignatureDrawing(true);
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
  };

  const handleSignatureDrawMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isSignatureDrawing) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();
  };

  const handleSignatureDrawEnd = () => {
    setIsSignatureDrawing(false);
  };

  const clearSignaturePad = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  };

  const applySignature = async (saveForLater: boolean = false) => {
    if (!signatureCanvasRef.current) return;
    const dataUrl = signatureCanvasRef.current.toDataURL("image/png");

    if (saveForLater) {
      await saveSignatureToFile(dataUrl);
      setSavedSignatures(prev => [...prev, dataUrl].slice(-10));
    }

    const newSignature: Signature = {
      dataUrl,
      x: 100,
      y: 100,
      width: 200,
      height: 80,
      page: pdf.currentPage,
    };

    pushToHistory();
    updateCurrentTab({ signatures: [...signatures, newSignature] });
    setShowSignaturePad(false);
    setCurrentTool("none");
  };

  const _useSavedSignature = (dataUrl: string) => {
    const newSignature: Signature = {
      dataUrl,
      x: 100,
      y: 100,
      width: 200,
      height: 80,
      page: pdf.currentPage,
    };
    pushToHistory();
    updateCurrentTab({ signatures: [...signatures, newSignature] });
    setShowSignaturePad(false);
  };

  const _loadSignatureImage = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
      });

      if (selected) {
        const fileData = await readFile(selected);
        const blob = new Blob([fileData]);
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });

        const newSignature: Signature = {
          dataUrl,
          x: 100,
          y: 100,
          width: 200,
          height: 80,
          page: pdf.currentPage,
        };
        pushToHistory();
        updateCurrentTab({ signatures: [...signatures, newSignature] });
        setShowSignaturePad(false);
      }
    } catch (err) {
      console.error("Error loading signature:", err);
    }
  };

  const deleteSavedSignature = async (index: number) => {
    try {
      const dataDir = await appDataDir();
      const sigDir = await join(dataDir, "signatures");
      const sigFiles = await readDir(sigDir);
      const pngFiles = sigFiles.filter(f => f.name?.endsWith(".png")).sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      if (pngFiles[index]?.name) {
        const filePath = await join(sigDir, pngFiles[index].name);
        await remove(filePath);
      }

      setSavedSignatures(prev => prev.filter((_, i) => i !== index));
    } catch (err) {
      console.error("Error deleting signature:", err);
    }
  };

  // Save signature to app data
  const saveSignatureToFile = async (dataUrl: string): Promise<void> => {
    try {
      const dataDir = await appDataDir();
      const sigDir = await join(dataDir, "signatures");

      // Generate unique filename
      const timestamp = Date.now();
      const filePath = await join(sigDir, `sig_${timestamp}.png`);

      // Convert data URL to binary
      const base64Data = dataUrl.split(",")[1];
      const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

      await writeFile(filePath, binaryData);
    } catch (err) {
      console.error("Error saving signature:", err);
    }
  };

  // Handle signature dragging
  const handleSignatureDragStart = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const sig = signatures[index];
    if (!overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;

    setDraggingSignature(index);
    setSignatureDragOffset({
      x: (e.clientX - rect.left) * scaleX - sig.x,
      y: (e.clientY - rect.top) * scaleY - sig.y,
    });
  };

  const handleSignatureDrag = (e: React.MouseEvent) => {
    if (draggingSignature === null || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;

    const newX = (e.clientX - rect.left) * scaleX - signatureDragOffset.x;
    const newY = (e.clientY - rect.top) * scaleY - signatureDragOffset.y;

    updateCurrentTab({
      signatures: signatures.map((sig, i) =>
        i === draggingSignature ? { ...sig, x: newX, y: newY } : sig
      )
    });
  };

  const handleSignatureDragEnd = () => {
    setDraggingSignature(null);
  };

  const deleteSignature = (index: number) => {
    updateCurrentTab({ signatures: signatures.filter((_, i) => i !== index) });
  };

  // Place signature mode - select a saved signature and click to place
  const startPlaceSignature = (dataUrl: string) => {
    setPendingSignature(dataUrl);
    setCurrentTool("sign");
    setShowSignaturePad(false);
    setActiveMenu(null);
  };

  // Get signature dimensions from data URL
  const getSignatureDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Scale to reasonable size while preserving aspect ratio
        const maxWidth = 200;
        const maxHeight = 100;
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        resolve({
          width: img.width * scale,
          height: img.height * scale,
        });
      };
      img.src = dataUrl;
    });
  };

  // Handle canvas click for placing signature or text
  const handleCanvasClick = async (e: React.MouseEvent) => {
    if (!overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (currentTool === "sign" && pendingSignature) {
      // Get actual signature dimensions preserving aspect ratio
      const dims = await getSignatureDimensions(pendingSignature);
      const displayScale = pdf.zoom * 1.5 * window.devicePixelRatio;

      const newSignature: Signature = {
        dataUrl: pendingSignature,
        x: x - (dims.width * displayScale) / 2,
        y: y - (dims.height * displayScale) / 2,
        width: dims.width * displayScale,
        height: dims.height * displayScale,
        page: pdf.currentPage,
      };
      pushToHistory();
      updateCurrentTab({ signatures: [...signatures, newSignature] });
      setPendingSignature(null);
      setCurrentTool("none");
    } else if (currentTool === "text") {
      pushToHistory();
      const newText: TextAnnotation = {
        text: "",
        x,
        y,
        fontSize: 14,
        page: pdf.currentPage,
      };
      updateCurrentTab({ textAnnotations: [...textAnnotations, newText] });
      setEditingTextIndex(textAnnotations.length);
    } else if (currentTool === "note") {
      addStickyNote(x, y);
    } else if (currentTool === "image" && pendingImage) {
      placeImage(x, y);
    }
  };

  // Handle drawing mouse events
  const handleDrawMouseDown = (e: React.MouseEvent) => {
    if (currentTool !== "draw" || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    startDrawing(x, y);
  };

  const handleDrawMouseMove = (e: React.MouseEvent) => {
    if (currentTool !== "draw" || !isDrawing || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    continueDrawing(x, y);
  };

  const handleDrawMouseUp = () => {
    if (currentTool === "draw" && isDrawing) {
      finishDrawing();
    }
  };

  // Text annotation functions
  const updateTextAnnotation = (index: number, text: string) => {
    updateCurrentTab({
      textAnnotations: textAnnotations.map((ann, i) =>
        i === index ? { ...ann, text } : ann
      )
    });
  };

  const deleteTextAnnotation = (index: number) => {
    updateCurrentTab({ textAnnotations: textAnnotations.filter((_, i) => i !== index) });
    if (editingTextIndex === index) setEditingTextIndex(null);
  };

  // Highlight functions
  const addHighlight = (rects: { x: number; y: number; width: number; height: number }[], text: string) => {
    pushToHistory();
    const newHighlight: Highlight = {
      id: `hl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      rects,
      color: highlightColor,
      page: pdf.currentPage,
      text,
    };
    updateCurrentTab({ highlights: [...highlights, newHighlight] });
  };

  const deleteHighlight = (id: string) => {
    pushToHistory();
    updateCurrentTab({ highlights: highlights.filter(h => h.id !== id) });
  };

  // Sticky note functions
  const addStickyNote = (x: number, y: number) => {
    pushToHistory();
    const newNote: StickyNote = {
      id: `note-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      x,
      y,
      text: "",
      color: noteColor,
      page: pdf.currentPage,
      isOpen: true,
    };
    updateCurrentTab({ stickyNotes: [...stickyNotes, newNote] });
    setEditingNoteId(newNote.id);
  };

  const updateStickyNote = (id: string, updates: Partial<StickyNote>) => {
    updateCurrentTab({
      stickyNotes: stickyNotes.map(n => n.id === id ? { ...n, ...updates } : n)
    });
  };

  const deleteStickyNote = (id: string) => {
    pushToHistory();
    updateCurrentTab({ stickyNotes: stickyNotes.filter(n => n.id !== id) });
    if (editingNoteId === id) setEditingNoteId(null);
  };

  // Freehand drawing functions
  const startDrawing = (x: number, y: number) => {
    pushToHistory();
    setCurrentStroke([{ x, y }]);
    setIsDrawing(true);
  };

  const continueDrawing = (x: number, y: number) => {
    if (!isDrawing) return;
    setCurrentStroke(prev => [...prev, { x, y }]);
  };

  const finishDrawing = () => {
    if (currentStroke.length > 1) {
      const newStroke: FreehandStroke = {
        points: currentStroke,
        color: drawColor,
        width: drawWidth,
        page: pdf.currentPage,
      };
      updateCurrentTab({ freehandStrokes: [...freehandStrokes, newStroke] });
    }
    setCurrentStroke([]);
    setIsDrawing(false);
  };

  // Image insertion
  const loadImageForInsertion = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp"] }],
      });

      if (selected) {
        const fileData = await readFile(selected);
        const blob = new Blob([fileData]);
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
        setPendingImage(dataUrl);
        setCurrentTool("image");
      }
    } catch (err) {
      console.error("Error loading image:", err);
    }
  };

  const placeImage = (x: number, y: number) => {
    if (!pendingImage) return;

    const img = new Image();
    img.onload = () => {
      pushToHistory();
      const scale = pdf.zoom * 1.5 * window.devicePixelRatio;
      const maxWidth = 300;
      const ratio = Math.min(1, maxWidth / img.width);
      const newImage: ImageAnnotation = {
        id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        dataUrl: pendingImage,
        x: x - (img.width * ratio * scale) / 2,
        y: y - (img.height * ratio * scale) / 2,
        width: img.width * ratio * scale,
        height: img.height * ratio * scale,
        page: pdf.currentPage,
      };
      updateCurrentTab({ imageAnnotations: [...imageAnnotations, newImage] });
      setPendingImage(null);
      setCurrentTool("none");
    };
    img.src = pendingImage;
  };

  const deleteImage = (id: string) => {
    pushToHistory();
    updateCurrentTab({ imageAnnotations: imageAnnotations.filter(i => i.id !== id) });
  };

  // Link creation
  const _createLink = () => {
    if (!pendingLinkRect || !newLinkUrl.trim()) return;

    pushToHistory();
    const newLink: LinkAnnotation = {
      id: `link-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      ...pendingLinkRect,
      url: newLinkUrl.startsWith("http") ? newLinkUrl : `https://${newLinkUrl}`,
      page: pdf.currentPage,
    };
    updateCurrentTab({ linkAnnotations: [...linkAnnotations, newLink] });
    setPendingLinkRect(null);
    setNewLinkUrl("");
    setShowLinkModal(false);
    setCurrentTool("none");
  };

  const deleteLink = (id: string) => {
    pushToHistory();
    updateCurrentTab({ linkAnnotations: linkAnnotations.filter(l => l.id !== id) });
  };

  // Custom bookmarks
  const addCustomBookmark = () => {
    if (!newBookmarkTitle.trim()) return;

    pushToHistory();
    const newBookmark: CustomBookmark = {
      id: `bm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      title: newBookmarkTitle,
      page: pdf.currentPage,
    };
    updateCurrentTab({ customBookmarks: [...customBookmarks, newBookmark] });
    setNewBookmarkTitle("");
    setShowBookmarkModal(false);
  };

  const deleteCustomBookmark = (id: string) => {
    pushToHistory();
    updateCurrentTab({ customBookmarks: customBookmarks.filter(b => b.id !== id) });
  };

  // Apply watermark to PDF
  const applyWatermark = async () => {
    if (!pdfBytes || !watermarkConfig.text.trim()) return;

    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      for (const page of pages) {
        const { width, height } = page.getSize();
        const fontSize = watermarkConfig.fontSize;

        // Parse color
        const hexColor = watermarkConfig.color.replace("#", "");
        const r = parseInt(hexColor.substr(0, 2), 16) / 255;
        const g = parseInt(hexColor.substr(2, 2), 16) / 255;
        const b = parseInt(hexColor.substr(4, 2), 16) / 255;

        if (watermarkConfig.position === "tile") {
          // Tile watermark across page
          const textWidth = fontSize * watermarkConfig.text.length * 0.5;
          const spacing = textWidth + 100;
          for (let y = 50; y < height; y += spacing) {
            for (let x = 50; x < width; x += spacing) {
              page.drawText(watermarkConfig.text, {
                x,
                y,
                size: fontSize,
                color: rgb(r, g, b),
                opacity: watermarkConfig.opacity,
                rotate: degrees(watermarkConfig.angle),
              });
            }
          }
        } else {
          // Center or diagonal
          const textWidth = fontSize * watermarkConfig.text.length * 0.5;
          page.drawText(watermarkConfig.text, {
            x: width / 2 - textWidth / 2,
            y: height / 2,
            size: fontSize,
            color: rgb(r, g, b),
            opacity: watermarkConfig.opacity,
            rotate: degrees(watermarkConfig.position === "diagonal" ? watermarkConfig.angle : 0),
          });
        }
      }

      const newBytes = await pdfDoc.save();
      const newBytesArray = new Uint8Array(newBytes);

      // Reload the document
      const newDoc = await pdfjsLib.getDocument({ data: newBytesArray }).promise;
      updateCurrentTab({
        doc: newDoc,
        pdfBytes: newBytesArray,
        totalPages: newDoc.numPages,
      });

      setShowWatermarkModal(false);
      await message("Watermark applied successfully!", { title: "Watermark" });
    } catch (err) {
      console.error("Error applying watermark:", err);
      await message(`Failed to apply watermark: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Apply header/footer to PDF
  const applyHeaderFooter = async () => {
    if (!pdfBytes) return;

    const cfg = headerFooterConfig;
    const hasContent = cfg.headerLeft || cfg.headerCenter || cfg.headerRight ||
                       cfg.footerLeft || cfg.footerCenter || cfg.footerRight ||
                       cfg.includePageNumbers;

    if (!hasContent) {
      await message("Please enter at least one header or footer text.", { title: "Header/Footer" });
      return;
    }

    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      const totalPages = pages.length;
      const startPage = Math.max(1, cfg.startPage) - 1;
      const endPage = cfg.endPage > 0 ? Math.min(cfg.endPage, totalPages) : totalPages;

      for (let i = startPage; i < endPage; i++) {
        const page = pages[i];
        const { width, height } = page.getSize();
        const pageNum = i + 1;

        const replaceVars = (text: string) =>
          text.replace(/{page}/gi, String(pageNum))
              .replace(/{total}/gi, String(totalPages))
              .replace(/{date}/gi, new Date().toLocaleDateString());

        // Header
        if (cfg.headerLeft) {
          page.drawText(replaceVars(cfg.headerLeft), {
            x: 40,
            y: height - 30,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }
        if (cfg.headerCenter) {
          const text = replaceVars(cfg.headerCenter);
          page.drawText(text, {
            x: width / 2 - (text.length * cfg.fontSize * 0.3),
            y: height - 30,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }
        if (cfg.headerRight) {
          const text = replaceVars(cfg.headerRight);
          page.drawText(text, {
            x: width - 40 - (text.length * cfg.fontSize * 0.5),
            y: height - 30,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }

        // Footer
        if (cfg.footerLeft) {
          page.drawText(replaceVars(cfg.footerLeft), {
            x: 40,
            y: 20,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }
        const footerCenterText = cfg.includePageNumbers && !cfg.footerCenter
          ? `Page ${pageNum} of ${totalPages}`
          : replaceVars(cfg.footerCenter);
        if (footerCenterText) {
          page.drawText(footerCenterText, {
            x: width / 2 - (footerCenterText.length * cfg.fontSize * 0.3),
            y: 20,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }
        if (cfg.footerRight) {
          const text = replaceVars(cfg.footerRight);
          page.drawText(text, {
            x: width - 40 - (text.length * cfg.fontSize * 0.5),
            y: 20,
            size: cfg.fontSize,
            color: rgb(0, 0, 0),
          });
        }
      }

      const newBytes = await pdfDoc.save();
      const newBytesArray = new Uint8Array(newBytes);

      const newDoc = await pdfjsLib.getDocument({ data: newBytesArray }).promise;
      updateCurrentTab({
        doc: newDoc,
        pdfBytes: newBytesArray,
        totalPages: newDoc.numPages,
      });

      setShowHeaderFooterModal(false);
      await message("Headers and footers applied successfully!", { title: "Header/Footer" });
    } catch (err) {
      console.error("Error applying header/footer:", err);
      await message(`Failed to apply header/footer: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Signature image cropping
  const loadSignatureForCrop = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
      });

      if (selected) {
        const fileData = await readFile(selected);
        const blob = new Blob([fileData]);
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });

        setCropImageSrc(dataUrl);
        setShowCropModal(true);
        setShowSignaturePad(false);

        // Load image to get dimensions
        const img = new Image();
        img.onload = () => {
          setCropRect({ x: 0, y: 0, width: img.width, height: img.height });
        };
        img.src = dataUrl;
      }
    } catch (err) {
      console.error("Error loading image:", err);
    }
  };

  const handleCropMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropCanvasRef.current) return;
    const rect = cropCanvasRef.current.getBoundingClientRect();
    setIsCropping(true);
    setCropStart({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleCropMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isCropping || !cropCanvasRef.current) return;
    const rect = cropCanvasRef.current.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    setCropRect({
      x: Math.min(cropStart.x, currentX),
      y: Math.min(cropStart.y, currentY),
      width: Math.abs(currentX - cropStart.x),
      height: Math.abs(currentY - cropStart.y),
    });
  };

  const handleCropMouseUp = () => {
    setIsCropping(false);
  };

  const applyCrop = async () => {
    if (!cropImageSrc || cropRect.width < 10 || cropRect.height < 10) return;

    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Translate canvas coordinates to original image coordinates
      const imgX = (cropRect.x - cropImageBounds.x) / cropImageBounds.scale;
      const imgY = (cropRect.y - cropImageBounds.y) / cropImageBounds.scale;
      const imgW = cropRect.width / cropImageBounds.scale;
      const imgH = cropRect.height / cropImageBounds.scale;

      // Clamp to image bounds
      const clampedX = Math.max(0, imgX);
      const clampedY = Math.max(0, imgY);
      const clampedW = Math.min(img.width - clampedX, imgW);
      const clampedH = Math.min(img.height - clampedY, imgH);

      canvas.width = clampedW;
      canvas.height = clampedH;

      ctx.drawImage(
        img,
        clampedX, clampedY, clampedW, clampedH,
        0, 0, clampedW, clampedH
      );

      const croppedDataUrl = canvas.toDataURL("image/png");

      // Save to app data
      await saveSignatureToFile(croppedDataUrl);
      setSavedSignatures(prev => [...prev, croppedDataUrl].slice(-10));

      setShowCropModal(false);
      setCropImageSrc(null);

      // Immediately start placing this signature
      startPlaceSignature(croppedDataUrl);
    };
    img.src = cropImageSrc;
  };

  // Save PDF with text annotations
  const saveAnnotatedPDF = async () => {
    setActiveMenu(null);

    try {
      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: pdf.fileName?.replace(".pdf", "_annotated.pdf") || "annotated.pdf",
      });

      if (savePath) {
        const sourceBytes = await getPdfBytesForSave();
        const pdfDoc = await loadEditablePdf(sourceBytes);
        const pages = pdfDoc.getPages();

        // Add text annotations
        for (const ann of textAnnotations) {
          const page = pages[ann.page - 1];
          if (!page || !ann.text) continue;

          const { height: pageHeight } = page.getSize();
          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;

          page.drawText(ann.text, {
            x: ann.x / scale * (page.getWidth() / (canvasRef.current?.width || 1) * scale),
            y: pageHeight - ann.y / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
            size: ann.fontSize,
            color: rgb(0, 0, 0),
          });
        }

        // Add signatures
        for (const sig of signatures) {
          const page = pages[sig.page - 1];
          if (!page) continue;

          const { height: pageHeight } = page.getSize();
          const pngImage = await pdfDoc.embedPng(sig.dataUrl);
          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;

          page.drawImage(pngImage, {
            x: sig.x / scale * (page.getWidth() / (canvasRef.current?.width || 1) * scale),
            y: pageHeight - (sig.y + sig.height) / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
            width: sig.width / scale * (page.getWidth() / (canvasRef.current?.width || 1) * scale),
            height: sig.height / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
          });
        }

        // Add redactions
        for (const redaction of redactions) {
          const page = pages[redaction.page - 1];
          if (!page) continue;

          const { width: pageWidth, height: pageHeight } = page.getSize();
          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;

          page.drawRectangle({
            x: redaction.x / scale * (pageWidth / (canvasRef.current?.width || 1) * scale),
            y: pageHeight - (redaction.y + redaction.height) / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
            width: redaction.width / scale * (pageWidth / (canvasRef.current?.width || 1) * scale),
            height: redaction.height / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
            color: rgb(0, 0, 0),
          });
        }

        const modifiedPdfBytes = await pdfDoc.save();
        await writeFile(savePath, modifiedPdfBytes);
        await message(`Saved annotated PDF to ${savePath}`, { title: "Save Complete" });
      }
    } catch (err) {
      console.error("Error saving annotated PDF:", err);
      await message(`Save failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Save PDF with signatures
  const _saveSignedPDF = async () => {
    if (signatures.length === 0) return;
    setActiveMenu(null);

    try {
      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: pdf.fileName?.replace(".pdf", "_signed.pdf") || "signed.pdf",
      });

      if (savePath) {
        const sourceBytes = await getPdfBytesForSave();
        const pdfDoc = await loadEditablePdf(sourceBytes);
        const pages = pdfDoc.getPages();

        for (const sig of signatures) {
          const page = pages[sig.page - 1];
          if (!page) continue;

          const { height: pageHeight } = page.getSize();
          const pngImage = await pdfDoc.embedPng(sig.dataUrl);
          const scale = pdf.zoom * 1.5 * window.devicePixelRatio;

          page.drawImage(pngImage, {
            x: sig.x / scale * (page.getWidth() / (canvasRef.current?.width || 1) * scale),
            y: pageHeight - (sig.y + sig.height) / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
            width: sig.width / scale * (page.getWidth() / (canvasRef.current?.width || 1) * scale),
            height: sig.height / scale * (pageHeight / (canvasRef.current?.height || 1) * scale),
          });
        }

        const modifiedPdfBytes = await pdfDoc.save();
        await writeFile(savePath, modifiedPdfBytes);
        await message(`Saved signed PDF to ${savePath}`, { title: "Save Complete" });
      }
    } catch (err) {
      console.error("Error saving signed PDF:", err);
      await message(`Save failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Reorder pages
  const reorderPages = async () => {
    setActiveMenu(null);

    const newOrder = prompt(
      `Enter new page order (comma-separated).\nCurrent pages: 1-${pdf.totalPages}\nExample: 3,1,2,4`,
      Array.from({ length: pdf.totalPages }, (_, i) => i + 1).join(",")
    );

    if (!newOrder) return;

    try {
      const pageNumbers = newOrder.split(",").map(n => parseInt(n.trim()));

      if (pageNumbers.some(n => isNaN(n) || n < 1 || n > pdf.totalPages)) {
        await message("Invalid page numbers. Please enter valid page numbers.", { title: "Error", kind: "error" });
        return;
      }

      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: pdf.fileName?.replace(".pdf", "_reordered.pdf") || "reordered.pdf",
      });

      if (savePath) {
        const sourceBytes = await getPdfBytesForSave();
        const srcDoc = await loadEditablePdf(sourceBytes);
        const newDoc = await PDFDocument.create();

        const copiedPages = await newDoc.copyPages(srcDoc, pageNumbers.map(n => n - 1));
        copiedPages.forEach(page => newDoc.addPage(page));

        const newBytes = await newDoc.save();
        await writeFile(savePath, newBytes);
        await message(`Saved reordered PDF to ${savePath}`, { title: "Save Complete" });
      }
    } catch (err) {
      console.error("Error reordering pages:", err);
      await message(`Reorder failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Rotate pages
  const rotatePages = async (direction: "cw" | "ccw", allPages: boolean) => {
    setActiveMenu(null);

    try {
      const sourceBytes = await getPdfBytesForSave();
      const pdfDoc = await loadEditablePdf(sourceBytes);
      const pages = pdfDoc.getPages();
      const degrees = direction === "cw" ? 90 : -90;

      if (allPages) {
        pages.forEach(page => {
          const currentRotation = page.getRotation().angle;
          page.setRotation({ type: "degrees", angle: currentRotation + degrees } as any);
        });
      } else {
        const page = pages[pdf.currentPage - 1];
        if (page) {
          const currentRotation = page.getRotation().angle;
          page.setRotation({ type: "degrees", angle: currentRotation + degrees } as any);
        }
      }

      const modifiedBytes = await pdfDoc.save();
      const modifiedData = new Uint8Array(modifiedBytes);

      const doc = await loadViewerDocument(modifiedData);
      const newThumbs = await generateThumbnailsForDoc(doc);

      updateCurrentTab({ pdfBytes: clonePdfBytes(modifiedData), doc, thumbnails: newThumbs });
      await message(`Rotated ${allPages ? "all pages" : "current page"} ${direction === "cw" ? "clockwise" : "counter-clockwise"}`, { title: "Rotation Complete" });
    } catch (err) {
      console.error("Error rotating pages:", err);
      await message(`Rotation failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Delete current page
  const deletePage = async () => {
    if (pdf.totalPages <= 1) return;
    setActiveMenu(null);

    try {
      const sourceBytes = await getPdfBytesForSave();
      const pdfDoc = await loadEditablePdf(sourceBytes);
      pdfDoc.removePage(pdf.currentPage - 1);

      const modifiedBytes = await pdfDoc.save();
      const modifiedData = new Uint8Array(modifiedBytes);

      const doc = await loadViewerDocument(modifiedData);
      const newThumbs = await generateThumbnailsForDoc(doc);

      updateCurrentTab({
        pdfBytes: clonePdfBytes(modifiedData),
        doc,
        currentPage: Math.min(pdf.currentPage, doc.numPages),
        totalPages: doc.numPages,
        thumbnails: newThumbs,
      });
      await message(`Deleted page ${pdf.currentPage}`, { title: "Page Deleted" });
    } catch (err) {
      console.error("Error deleting page:", err);
      await message(`Delete failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Save modified PDF
  const saveModifiedPDF = async () => {
    setActiveMenu(null);

    try {
      const savePath = await save({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        defaultPath: pdf.fileName || "document.pdf",
      });

      if (savePath) {
        const sourceBytes = await getPdfBytesForSave();
        await writeFile(savePath, sourceBytes);
        await message(`Saved PDF to ${savePath}`, { title: "Save Complete" });
      }
    } catch (err) {
      console.error("Error saving PDF:", err);
      await message(`Save failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Extract all text from PDF
  const extractAllText = async (): Promise<string> => {
    if (!pdf.doc) return "";
    let allText = "";
    for (let i = 1; i <= pdf.totalPages; i++) {
      const page = await pdf.doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      allText += `--- Page ${i} ---\n${pageText}\n\n`;
    }
    return allText;
  };

  // Export to text-based formats
  const exportToFormat = async (format: "txt" | "rtf" | "html") => {
    if (!pdf.doc) return;
    setActiveMenu(null);

    try {
      const text = await extractAllText();
      let content: string;
      let ext: string;
      let filterName: string;

      switch (format) {
        case "rtf":
          content = `{\\rtf1\\ansi\\deff0\n${text.replace(/\n/g, "\\par\n")}\n}`;
          ext = "rtf";
          filterName = "Rich Text Format";
          break;
        case "html":
          content = `<!DOCTYPE html>\n<html>\n<head><title>${pdf.fileName}</title></head>\n<body>\n<pre>${text}</pre>\n</body>\n</html>`;
          ext = "html";
          filterName = "HTML Document";
          break;
        default:
          content = text;
          ext = "txt";
          filterName = "Text File";
      }

      const savePath = await save({
        filters: [{ name: filterName, extensions: [ext] }],
        defaultPath: pdf.fileName?.replace(".pdf", `.${ext}`) || `document.${ext}`,
      });

      if (savePath) {
        const encoder = new TextEncoder();
        await writeFile(savePath, encoder.encode(content));
        await message(`Exported to ${savePath}`, { title: "Export Complete" });
      }
    } catch (err) {
      console.error("Error exporting:", err);
      await message(`Export failed: ${err}`, { title: "Error", kind: "error" });
    }
  };

  // Toggle fullscreen
  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullScreen(true);
    } else {
      document.exitFullscreen();
      setIsFullScreen(false);
    }
    setActiveMenu(null);
  };

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullScreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Draw crop image on canvas
  useEffect(() => {
    if (showCropModal && cropImageSrc && cropCanvasRef.current) {
      const ctx = cropCanvasRef.current.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        const canvas = cropCanvasRef.current!;
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#333";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, x, y, w, h);

        // Store image bounds for accurate cropping
        setCropImageBounds({ x, y, width: w, height: h, scale });
        // Set initial crop rect to full image
        setCropRect({ x, y, width: w, height: h });
      };
      img.src = cropImageSrc;
    }
  }, [showCropModal, cropImageSrc]);

  // Navigation
  const goToPage = (page: number) => {
    if (page >= 1 && page <= pdf.totalPages) {
      updateCurrentTab({ currentPage: page });
      // Save position
      if (pdf.filePath) {
        savePosition(pdf.filePath, page, pdf.zoom);
      }
      // Scroll to page in continuous view
      if (viewMode === "continuous" || viewMode === "two-page") {
        setTimeout(() => {
          const pageElement = document.querySelector(`[data-page="${page}"]`);
          if (pageElement) {
            pageElement.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }, 50);
      }
    }
  };

  const zoomIn = () => {
    if (pdf.zoom < 4.0) {
      const newZoom = Math.min(4.0, pdf.zoom * 1.25);
      updateCurrentTab({ zoom: newZoom });
      if (pdf.filePath) {
        savePosition(pdf.filePath, pdf.currentPage, newZoom);
      }
    }
  };

  const zoomOut = () => {
    if (pdf.zoom > 0.25) {
      const newZoom = Math.max(0.25, pdf.zoom / 1.25);
      updateCurrentTab({ zoom: newZoom });
      if (pdf.filePath) {
        savePosition(pdf.filePath, pdf.currentPage, newZoom);
      }
    }
  };

  const clampZoom = (zoom: number) => Math.max(0.25, Math.min(4.0, zoom));

  const fitWidth = async () => {
    if (containerRef.current && pdf.doc) {
      const page = await pdf.doc.getPage(pdf.currentPage);
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = Math.max(1, containerRef.current.clientWidth - 40);
      const newZoom = clampZoom(containerWidth / (viewport.width * 1.5));

      updateCurrentTab({ zoom: newZoom });
      if (pdf.filePath) {
        savePosition(pdf.filePath, pdf.currentPage, newZoom);
      }
    }
  };

  const fitPage = async () => {
    if (containerRef.current && pdf.doc) {
      const page = await pdf.doc.getPage(pdf.currentPage);
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = Math.max(1, containerRef.current.clientWidth - 40);
      const containerHeight = Math.max(1, containerRef.current.clientHeight - 40);
      const zoomW = containerWidth / (viewport.width * 1.5);
      const zoomH = containerHeight / (viewport.height * 1.5);
      const newZoom = clampZoom(Math.min(zoomW, zoomH));

      updateCurrentTab({ zoom: newZoom });
      if (pdf.filePath) {
        savePosition(pdf.filePath, pdf.currentPage, newZoom);
      }
    }
  };

  // Redaction tool handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (currentTool !== "redact" || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;

    setIsDrawing(true);
    setDrawStart({
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;

    const currentX = (e.clientX - rect.left) * scaleX;
    const currentY = (e.clientY - rect.top) * scaleY;

    const ctx = overlayCanvasRef.current.getContext("2d");
    if (!ctx) return;

    // Redraw existing redactions
    drawRedactions();

    // Draw current selection
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(
      Math.min(drawStart.x, currentX),
      Math.min(drawStart.y, currentY),
      Math.abs(currentX - drawStart.x),
      Math.abs(currentY - drawStart.y)
    );
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart || !overlayCanvasRef.current) return;

    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const scaleX = overlayCanvasRef.current.width / rect.width;
    const scaleY = overlayCanvasRef.current.height / rect.height;

    const endX = (e.clientX - rect.left) * scaleX;
    const endY = (e.clientY - rect.top) * scaleY;

    const newRedaction: RedactionRect = {
      x: Math.min(drawStart.x, endX),
      y: Math.min(drawStart.y, endY),
      width: Math.abs(endX - drawStart.x),
      height: Math.abs(endY - drawStart.y),
      page: pdf.currentPage,
    };

    if (newRedaction.width > 5 && newRedaction.height > 5) {
      pushToHistory();
      updateCurrentTab({ redactions: [...redactions, newRedaction] });
    }

    setIsDrawing(false);
    setDrawStart(null);
  };

  // Clear redactions for current page
  const _clearRedactions = () => {
    pushToHistory();
    updateCurrentTab({ redactions: redactions.filter(r => r.page !== pdf.currentPage) });
    setActiveMenu(null);
  };

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case "o":
          e.preventDefault();
          openFile();
          break;
        case "e":
          e.preventDefault();
          if (pdf.doc) exportToImage("png");
          break;
        case "=":
        case "+":
          e.preventDefault();
          zoomIn();
          break;
        case "-":
          e.preventDefault();
          zoomOut();
          break;
        case "0":
          e.preventDefault();
          updateCurrentTab({ zoom: 1.0 });
          break;
        case "p":
          e.preventDefault();
          if (pdf.doc) printPDF();
          break;
        case "s":
          e.preventDefault();
          if (pdf.doc) saveModifiedPDF();
          break;
        case "c":
          if (selectedText) {
            e.preventDefault();
            copySelectedText();
          }
          break;
        case "f":
          e.preventDefault();
          if (pdf.doc) {
            setShowFindBar(true);
          }
          break;
        case "z":
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
          break;
        case "y":
          e.preventDefault();
          redo();
          break;
      }
    } else {
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          goToPage(pdf.currentPage - 1);
          break;
        case "ArrowRight":
        case "PageDown":
          goToPage(pdf.currentPage + 1);
          break;
        case "Home":
          goToPage(1);
          break;
        case "End":
          goToPage(pdf.totalPages);
          break;
        case "Escape":
          setCurrentTool("none");
          setActiveMenu(null);
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
        case "F11":
          e.preventDefault();
          toggleFullScreen();
          break;
        case "F9":
          e.preventDefault();
          setSidebarOpen(prev => !prev);
          break;
      }
    }
  }, [pdf.currentPage, pdf.totalPages, pdf.doc]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClick = () => setActiveMenu(null);
    if (activeMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [activeMenu]);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === "light" ? "dark" : "light");
    setActiveMenu(null);
  };

  const handleWheel = useCallback((e: WheelEvent) => {
    if ((!e.ctrlKey && !e.metaKey) || !pdf.doc || !containerRef.current) return;

    e.preventDefault();

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const contentX = container.scrollLeft + mouseX;
    const contentY = container.scrollTop + mouseY;
    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    const newZoom = clampZoom(pdf.zoom * zoomFactor);

    if (newZoom === pdf.zoom) return;

    updateCurrentTab({ zoom: newZoom });
    if (pdf.filePath) {
      savePosition(pdf.filePath, pdf.currentPage, newZoom);
    }

    const scrollRatio = newZoom / pdf.zoom;
    window.setTimeout(() => {
      container.scrollLeft = contentX * scrollRatio - mouseX;
      container.scrollTop = contentY * scrollRatio - mouseY;
    }, 75);
  }, [pdf.doc, pdf.zoom, pdf.filePath, pdf.currentPage, updateCurrentTab]);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener("wheel", handleWheel, { passive: false });
      return () => container.removeEventListener("wheel", handleWheel);
    }
  }, [handleWheel]);

  // Bookmark tree component
  const BookmarkTree = ({ items, onNavigate, level = 0 }: { items: BookmarkItem[]; onNavigate: (page: number) => void; level?: number }) => (
    <div className="bookmark-tree" style={{ paddingLeft: level * 12 }}>
      {items.map((item, i) => (
        <div key={i} className="bookmark-item">
          <button onClick={() => onNavigate(item.page)} className="bookmark-link">
            {item.title}
            <span className="bookmark-page">p.{item.page}</span>
          </button>
          {item.children.length > 0 && (
            <BookmarkTree items={item.children} onNavigate={onNavigate} level={level + 1} />
          )}
        </div>
      ))}
    </div>
  );

  // Menu component
  type MenuItem = { label: string; action?: () => void; shortcut?: string; disabled?: boolean; separator?: never } | { separator: boolean; label?: never };
  const Menu = ({ name, items }: { name: string; items: MenuItem[] }) => (
    <div className="menu-container">
      <button
        className={`menu-button ${activeMenu === name ? "active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setActiveMenu(activeMenu === name ? null : name);
        }}
      >
        {name}
      </button>
      {activeMenu === name && (
        <div className="menu-dropdown">
          {items.map((item, i) =>
            'separator' in item ? (
              <div key={i} className="menu-separator" />
            ) : (
              <button
                key={i}
                className="menu-item"
                onClick={() => item.action?.()}
                disabled={item.disabled}
              >
                <span>{item.label}</span>
                {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={`app ${isFullScreen ? "fullscreen-mode" : ""}`}>
      {/* Menu Bar */}
      {!isFullScreen && (
      <div className="menu-bar">
        <Menu
          name="File"
          items={[
            { label: "Open...", action: openFile, shortcut: "Ctrl+O" },
            ...(recentFiles.length > 0 ? [
              { separator: true },
              ...recentFiles.slice(0, 5).map(f => ({ label: f.split(/[/\\]/).pop() || f, action: () => openRecentFile(f) })),
              { label: "Clear Recent Files", action: clearRecentFiles },
            ] : []),
            { separator: true },
            { label: "Save...", action: saveModifiedPDF, shortcut: "Ctrl+S", disabled: !pdf.doc },
            { label: "Save As...", action: saveAnnotatedPDF, disabled: !pdf.doc },
            { separator: true },
            { label: "Merge PDFs...", action: mergePDFs },
            { separator: true },
            { label: "Export Page as Image...", action: () => exportToImage("png"), shortcut: "Ctrl+E", disabled: !pdf.doc },
            { label: "Export All Pages as Images...", action: () => exportAllPages("png"), disabled: !pdf.doc },
            { label: "Export as Text...", action: () => exportToFormat("txt"), disabled: !pdf.doc },
            { separator: true },
            { label: "Copy Page to Clipboard", action: copyToClipboard, disabled: !pdf.doc },
            { label: "Print...", action: printPDF, shortcut: "Ctrl+P", disabled: !pdf.doc },
            { separator: true },
            { label: "Close Tab", action: () => { if (activeTabId) closeTab(activeTabId); setActiveMenu(null); }, disabled: !pdf.doc },
          ]}
        />
        <Menu
          name="Edit"
          items={[
            { label: "Undo", action: () => { undo(); setActiveMenu(null); }, shortcut: "Ctrl+Z", disabled: !canUndo },
            { label: "Redo", action: () => { redo(); setActiveMenu(null); }, shortcut: "Ctrl+Y", disabled: !canRedo },
            { separator: true },
            { label: "Find...", action: () => { setShowFindBar(true); setActiveMenu(null); }, shortcut: "Ctrl+F", disabled: !pdf.doc },
            { label: "Copy Selected Text", action: copySelectedText, shortcut: "Ctrl+C", disabled: !selectedText },
            { separator: true },
            { label: "Clear All Annotations", action: () => {
              pushToHistory();
              updateCurrentTab({
                redactions: [],
                signatures: [],
                textAnnotations: [],
                highlights: [],
                stickyNotes: [],
                freehandStrokes: [],
                imageAnnotations: [],
              });
              setActiveMenu(null);
            }, disabled: !pdf.doc || (redactions.length === 0 && signatures.length === 0 && textAnnotations.length === 0 && highlights.length === 0 && stickyNotes.length === 0 && freehandStrokes.length === 0 && imageAnnotations.length === 0) },
          ]}
        />
        <Menu
          name="Insert"
          items={[
            { label: "Text Box", action: () => { setCurrentTool("text"); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: "Sticky Note", action: () => { setCurrentTool("note"); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: "Image...", action: () => { loadImageForInsertion(); setActiveMenu(null); }, disabled: !pdf.doc },
            { separator: true },
            { label: "Draw Signature...", action: startSignature, disabled: !pdf.doc },
            { label: "Load Signature Image...", action: loadSignatureForCrop, disabled: !pdf.doc },
            ...(savedSignatures.length > 0 ? [
              { label: "Place Saved Signature", action: () => { setShowSignaturePad(true); setActiveMenu(null); }, disabled: !pdf.doc },
            ] : []),
            { separator: true },
            { label: "Bookmark at Current Page...", action: () => { setShowBookmarkModal(true); setActiveMenu(null); }, disabled: !pdf.doc },
          ]}
        />
        <Menu
          name="Annotate"
          items={[
            { label: currentTool === "highlight" ? "✓ Highlight Tool" : "Highlight Tool", action: () => { setCurrentTool(currentTool === "highlight" ? "none" : "highlight"); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: currentTool === "draw" ? "✓ Freehand Draw" : "Freehand Draw", action: () => { setCurrentTool(currentTool === "draw" ? "none" : "draw"); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: currentTool === "redact" ? "✓ Redact Tool" : "Redact Tool", action: () => { setCurrentTool(currentTool === "redact" ? "none" : "redact"); setActiveMenu(null); }, disabled: !pdf.doc },
            { separator: true },
            { label: "Clear Highlights", action: () => { pushToHistory(); updateCurrentTab({ highlights: [] }); setActiveMenu(null); }, disabled: highlights.length === 0 },
            { label: "Clear Drawings", action: () => { pushToHistory(); updateCurrentTab({ freehandStrokes: [] }); setActiveMenu(null); }, disabled: freehandStrokes.length === 0 },
            { label: "Clear Redactions", action: () => { pushToHistory(); updateCurrentTab({ redactions: [] }); setActiveMenu(null); }, disabled: redactions.length === 0 },
            { separator: true },
            { label: "Clear Sticky Notes", action: () => { pushToHistory(); updateCurrentTab({ stickyNotes: [] }); setActiveMenu(null); }, disabled: stickyNotes.length === 0 },
            { label: "Clear Text Boxes", action: () => { pushToHistory(); updateCurrentTab({ textAnnotations: [] }); setActiveMenu(null); }, disabled: textAnnotations.length === 0 },
            { label: "Clear Signatures", action: () => { pushToHistory(); updateCurrentTab({ signatures: [] }); setActiveMenu(null); }, disabled: signatures.length === 0 },
            { label: "Clear Images", action: () => { pushToHistory(); updateCurrentTab({ imageAnnotations: [] }); setActiveMenu(null); }, disabled: imageAnnotations.length === 0 },
          ]}
        />
        <Menu
          name="Document"
          items={[
            { label: "Add Watermark...", action: () => { setShowWatermarkModal(true); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: "Add Header/Footer...", action: () => { setShowHeaderFooterModal(true); setActiveMenu(null); }, disabled: !pdf.doc },
            { separator: true },
            { label: "Extract Text (OCR)...", action: runOCR, disabled: !pdf.doc || isOcrRunning },
            { label: "Read Aloud", action: () => { toggleSpeaking(); setActiveMenu(null); }, disabled: !pdf.doc },
          ]}
        />
        <Menu
          name="Page"
          items={[
            { label: "Rotate Clockwise", action: () => rotatePages("cw", false), disabled: !pdf.doc },
            { label: "Rotate Counter-Clockwise", action: () => rotatePages("ccw", false), disabled: !pdf.doc },
            { separator: true },
            { label: "Rotate All Clockwise", action: () => rotatePages("cw", true), disabled: !pdf.doc },
            { label: "Rotate All Counter-Clockwise", action: () => rotatePages("ccw", true), disabled: !pdf.doc },
            { separator: true },
            { label: "Reorder Pages...", action: reorderPages, disabled: !pdf.doc },
            { label: "Delete Current Page", action: deletePage, disabled: !pdf.doc || pdf.totalPages <= 1 },
          ]}
        />
        <Menu
          name="View"
          items={[
            { label: sidebarOpen ? "✓ Sidebar" : "Sidebar", action: () => { setSidebarOpen(!sidebarOpen); setActiveMenu(null); }, shortcut: "F9" },
            { separator: true },
            { label: viewMode === "single" ? "✓ Single Page" : "Single Page", action: () => { setViewMode("single"); setActiveMenu(null); } },
            { label: viewMode === "two-page" ? "✓ Two-Page" : "Two-Page", action: () => { setViewMode("two-page"); setActiveMenu(null); } },
            { label: viewMode === "continuous" ? "✓ Continuous" : "Continuous", action: () => { setViewMode("continuous"); setActiveMenu(null); } },
            { separator: true },
            { label: "Zoom In", action: zoomIn, shortcut: "Ctrl++", disabled: !pdf.doc },
            { label: "Zoom Out", action: zoomOut, shortcut: "Ctrl+-", disabled: !pdf.doc },
            { label: "Actual Size (100%)", action: () => { updateCurrentTab({ zoom: 1.0 }); setActiveMenu(null); }, shortcut: "Ctrl+0", disabled: !pdf.doc },
            { label: "Fit Width", action: () => { fitWidth(); setActiveMenu(null); }, disabled: !pdf.doc },
            { label: "Fit Page", action: () => { fitPage(); setActiveMenu(null); }, disabled: !pdf.doc },
            { separator: true },
            { label: "Go to First Page", action: () => { goToPage(1); setActiveMenu(null); }, shortcut: "Home", disabled: !pdf.doc },
            { label: "Go to Last Page", action: () => { goToPage(pdf.totalPages); setActiveMenu(null); }, shortcut: "End", disabled: !pdf.doc },
            { separator: true },
            { label: isFullScreen ? "✓ Full Screen" : "Full Screen", action: toggleFullScreen, shortcut: "F11" },
            { label: theme === "dark" ? "✓ Dark Mode" : "Dark Mode", action: toggleTheme },
          ]}
        />
        <Menu
          name="Help"
          items={[
            { label: "Keyboard Shortcuts", action: () => { message("Ctrl+O: Open\nCtrl+S: Save\nCtrl+F: Find\nCtrl+Z/Y: Undo/Redo\nCtrl++/-: Zoom\nF9: Toggle Sidebar\nF11: Full Screen\n←/→: Previous/Next Page\nHome/End: First/Last Page", { title: "Keyboard Shortcuts" }); setActiveMenu(null); } },
            { separator: true },
            { label: "Viridian Intelligence Website", action: () => { openUrl("https://www.viridianintelligence.co.uk/"); setActiveMenu(null); } },
            { separator: true },
            { label: "About Viridian Leaf", action: () => { setShowAbout(true); setActiveMenu(null); } },
          ]}
        />

        <div className="menu-spacer" />

        {/* Tool indicator */}
        {currentTool !== "none" && (
          <div className="tool-indicator">
            {currentTool === "redact" && "Redact Tool - Draw to redact"}
            {currentTool === "highlight" && "Highlight Tool - Select text"}
            {currentTool === "note" && "Note Tool - Click to add"}
            {currentTool === "draw" && "Draw Tool - Freehand drawing"}
            {currentTool === "text" && "Text Tool - Click to add text"}
            {currentTool === "sign" && "Sign Tool - Click to place"}
            <button onClick={() => setCurrentTool("none")}><Icon path={mdiClose} size={0.6} /></button>
          </div>
        )}

        {/* Text-to-Speech */}
        {pdf.doc && (
          <button
            className={`tts-button ${isSpeaking ? "active" : ""}`}
            onClick={toggleSpeaking}
            title={isSpeaking ? "Stop Speaking" : selectedText ? "Read Selected Text" : "Read Page Aloud"}
          >
            {isSpeaking ? "Stop" : selectedText ? "Read Selection" : "Read"}
          </button>
        )}
      </div>
      )}

      {/* Tab Bar */}
      {!isFullScreen && tabs.length > 0 && (
      <div className="tab-bar">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => setActiveTabId(tab.id)}
          >
            <span className="tab-title">{tab.fileName || "New Tab"}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-new" onClick={() => openFile(true)} title="Open in new tab"><Icon path={mdiPlus} size={0.9} /></button>
      </div>
      )}

      {/* Toolbar */}
      {!isFullScreen && (
      <div className="toolbar">
        <div className="toolbar-group">
          <button onClick={() => openFile()} title="Open PDF (Ctrl+O)">Open</button>
          <button onClick={() => exportToImage("png")} disabled={!pdf.doc} title="Export to Image (Ctrl+E)">Export</button>
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group nav-group">
          <button onClick={() => goToPage(pdf.currentPage - 1)} disabled={!pdf.doc || pdf.currentPage <= 1}>&lt;</button>
          <input
            type="number"
            value={pdf.doc ? pdf.currentPage : 0}
            onChange={(e) => goToPage(parseInt(e.target.value) || 1)}
            min={1}
            max={pdf.totalPages}
            disabled={!pdf.doc}
          />
          <span>/ {pdf.totalPages || 0}</span>
          <button onClick={() => goToPage(pdf.currentPage + 1)} disabled={!pdf.doc || pdf.currentPage >= pdf.totalPages}>&gt;</button>
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group">
          <button onClick={zoomOut} disabled={!pdf.doc} title="Zoom Out (Ctrl+-)"><Icon path={mdiMinus} size={0.7} /></button>
          <span className="zoom-level">{Math.round(pdf.zoom * 100)}%</span>
          <button onClick={zoomIn} disabled={!pdf.doc} title="Zoom In (Ctrl++)"><Icon path={mdiPlus} size={0.7} /></button>
          <button onClick={fitWidth} disabled={!pdf.doc} title="Fit Width"><Icon path={mdiFitToScreen} size={0.7} /></button>
        </div>

        <div className="toolbar-separator" />

        <div className="toolbar-group tools-group">
          <button
            onClick={() => setCurrentTool(currentTool === "redact" ? "none" : "redact")}
            disabled={!pdf.doc}
            className={currentTool === "redact" ? "active" : ""}
            title="Redact Tool"
          >
            <Icon path={mdiSquare} size={0.7} />
          </button>
          <button
            onClick={() => setCurrentTool(currentTool === "highlight" ? "none" : "highlight")}
            disabled={!pdf.doc}
            className={currentTool === "highlight" ? "active" : ""}
            title="Highlight Tool"
            style={{ backgroundColor: currentTool === "highlight" ? highlightColor : undefined }}
          >
            <Icon path={mdiFormatColorHighlight} size={0.7} />
          </button>
          <button
            onClick={() => setCurrentTool(currentTool === "note" ? "none" : "note")}
            disabled={!pdf.doc}
            className={currentTool === "note" ? "active" : ""}
            title="Sticky Note Tool"
          >
            <Icon path={mdiNoteOutline} size={0.7} />
          </button>
          <button
            onClick={() => setCurrentTool(currentTool === "draw" ? "none" : "draw")}
            disabled={!pdf.doc}
            className={currentTool === "draw" ? "active" : ""}
            title="Freehand Draw Tool"
          >
            <Icon path={mdiPencil} size={0.7} />
          </button>
          <button
            onClick={() => setCurrentTool(currentTool === "text" ? "none" : "text")}
            disabled={!pdf.doc}
            className={currentTool === "text" ? "active" : ""}
            title="Add Text (Form Fill)"
          >
            <Icon path={mdiFormatText} size={0.7} />
          </button>
        </div>

        {/* Color pickers for tools */}
        {currentTool === "highlight" && (
          <div className="toolbar-group">
            <input
              type="color"
              value={highlightColor}
              onChange={(e) => setHighlightColor(e.target.value)}
              title="Highlight Color"
            />
          </div>
        )}
        {currentTool === "draw" && (
          <div className="toolbar-group">
            <input
              type="color"
              value={drawColor}
              onChange={(e) => setDrawColor(e.target.value)}
              title="Draw Color"
            />
            <input
              type="range"
              min="1"
              max="10"
              value={drawWidth}
              onChange={(e) => setDrawWidth(parseInt(e.target.value))}
              title="Line Width"
              style={{ width: 60 }}
            />
          </div>
        )}
      </div>
      )}

      {/* Main Content */}
      <div className="main-content">
        {/* Sidebar Toggle Button */}
        {!isFullScreen && (
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title={sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}
          >
            <Icon path={sidebarOpen ? mdiChevronLeft : mdiChevronRight} size={0.7} />
          </button>
        )}

        {/* Sidebar */}
        {!isFullScreen && sidebarOpen && (
        <div className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={sidebarMode === "thumbnails" ? "active" : ""}
              onClick={() => setSidebarMode("thumbnails")}
              title="Page Thumbnails"
            >
              <Icon path={mdiFileDocumentOutline} size={0.8} />
            </button>
            <button
              className={sidebarMode === "bookmarks" ? "active" : ""}
              onClick={() => setSidebarMode("bookmarks")}
              title="Table of Contents / Bookmarks"
              disabled={bookmarks.length === 0 && customBookmarks.length === 0}
            >
              <Icon path={mdiBookmarkMultipleOutline} size={0.8} />
            </button>
            <button
              className={sidebarMode === "annotations" ? "active" : ""}
              onClick={() => setSidebarMode("annotations")}
              title="Annotations"
            >
              <Icon path={mdiTextBoxOutline} size={0.8} />
            </button>
          </div>

          {/* Thumbnails */}
          {sidebarMode === "thumbnails" && (
          <div className="thumbnail-list">
            {thumbnails.map((thumb, index) => (
              <div
                key={index}
                className={`thumbnail ${pdf.currentPage === index + 1 ? "active" : ""}`}
                onClick={() => goToPage(index + 1)}
              >
                {thumb ? (
                  <img src={thumb} alt={`Page ${index + 1}`} />
                ) : (
                  <div className="thumbnail-placeholder">?</div>
                )}
                <span>{index + 1}</span>
              </div>
            ))}
          </div>
          )}

          {/* Bookmarks / Table of Contents */}
          {sidebarMode === "bookmarks" && (
          <div className="bookmarks-list">
            {customBookmarks.length > 0 && (
              <div className="custom-bookmarks-section">
                <div className="section-header">Your Bookmarks</div>
                {customBookmarks.map((bm) => (
                  <div key={bm.id} className="custom-bookmark-item">
                    <button onClick={() => goToPage(bm.page)} className="bookmark-link">
                      {bm.title}
                      <span className="bookmark-page">p.{bm.page}</span>
                    </button>
                    <button onClick={() => deleteCustomBookmark(bm.id)} className="bookmark-delete"><Icon path={mdiClose} size={0.5} /></button>
                  </div>
                ))}
              </div>
            )}
            {bookmarks.length > 0 && (
              <div className="pdf-bookmarks-section">
                {customBookmarks.length > 0 && <div className="section-header">PDF Table of Contents</div>}
                <BookmarkTree items={bookmarks} onNavigate={goToPage} />
              </div>
            )}
            {bookmarks.length === 0 && customBookmarks.length === 0 && (
              <div className="no-bookmarks">No bookmarks yet</div>
            )}
            <button className="add-bookmark-btn" onClick={() => setShowBookmarkModal(true)} disabled={!pdf.doc}>
              + Add Bookmark Here
            </button>
          </div>
          )}

          {/* Annotations List */}
          {sidebarMode === "annotations" && (
          <div className="annotations-list">
            {highlights.length === 0 && stickyNotes.length === 0 && textAnnotations.length === 0 ? (
              <div className="no-annotations">No annotations yet</div>
            ) : (
              <>
                {highlights.map(h => (
                  <div key={h.id} className="annotation-item highlight-item" onClick={() => goToPage(h.page)}>
                    <span className="annotation-icon" style={{ backgroundColor: h.color }}><Icon path={mdiFormatColorHighlight} size={0.5} /></span>
                    <span className="annotation-text">{h.text.slice(0, 30)}...</span>
                    <span className="annotation-page">p.{h.page}</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteHighlight(h.id); }}><Icon path={mdiClose} size={0.5} /></button>
                  </div>
                ))}
                {stickyNotes.map(n => (
                  <div key={n.id} className="annotation-item note-item" onClick={() => goToPage(n.page)}>
                    <span className="annotation-icon" style={{ backgroundColor: n.color }}><Icon path={mdiNoteOutline} size={0.5} /></span>
                    <span className="annotation-text">{n.text.slice(0, 30) || "(empty note)"}</span>
                    <span className="annotation-page">p.{n.page}</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteStickyNote(n.id); }}><Icon path={mdiClose} size={0.5} /></button>
                  </div>
                ))}
                {textAnnotations.map((t, i) => (
                  <div key={i} className="annotation-item text-item" onClick={() => goToPage(t.page)}>
                    <span className="annotation-icon">T</span>
                    <span className="annotation-text">{t.text.slice(0, 30) || "(empty)"}</span>
                    <span className="annotation-page">p.{t.page}</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteTextAnnotation(i); }}><Icon path={mdiClose} size={0.5} /></button>
                  </div>
                ))}
              </>
            )}
          </div>
          )}
        </div>
        )}

        {/* PDF Viewer */}
        <div
          className="viewer-container"
          ref={containerRef}
        >
          {isLoading ? (
            <div className="loading">Loading PDF...</div>
          ) : error ? (
            <div className="empty-state">
              <h2>Error Loading PDF</h2>
              <p style={{ color: "#ff6b6b" }}>{error}</p>
              <button onClick={() => openFile()}>Try Again</button>
            </div>
          ) : pdf.doc ? (
            viewMode === "single" ? (
            <div
              className="canvas-container"
              onMouseMove={handleSignatureDrag}
              onMouseUp={handleSignatureDragEnd}
              onMouseLeave={handleSignatureDragEnd}
            >
              <canvas ref={canvasRef} className="pdf-canvas" />
              <div
                ref={textLayerRef}
                className="text-layer"
                onMouseUp={handleTextSelection}
                style={{
                  cursor: currentTool === "highlight" ? "text" : undefined,
                  zIndex: currentTool === "highlight" ? 10 : undefined,
                }}
              />
              <canvas
                ref={overlayCanvasRef}
                className="overlay-canvas"
                onMouseDown={(e) => {
                  if (currentTool === "redact") handleMouseDown(e);
                  else if (currentTool === "draw") handleDrawMouseDown(e);
                }}
                onMouseMove={(e) => {
                  if (currentTool === "redact") handleMouseMove(e);
                  else if (currentTool === "draw") handleDrawMouseMove(e);
                }}
                onMouseUp={(e) => {
                  if (currentTool === "redact") handleMouseUp(e);
                  else if (currentTool === "draw") handleDrawMouseUp();
                }}
                onMouseLeave={() => {
                  setIsDrawing(false);
                  setDrawStart(null);
                  if (currentTool === "draw") handleDrawMouseUp();
                }}
                onClick={handleCanvasClick}
                style={{
                  cursor: currentTool === "redact" ? "crosshair" :
                         currentTool === "draw" ? "crosshair" :
                         currentTool === "sign" && pendingSignature ? "copy" :
                         currentTool === "note" ? "cell" :
                         currentTool === "text" ? "text" : "default",
                  pointerEvents: (currentTool === "none" || currentTool === "highlight" || currentTool === "select") ? "none" : "auto"
                }}
              />

              {/* Highlight Overlays */}
              {highlights
                .filter(h => h.page === pdf.currentPage)
                .map(h => {
                  const _scale = pdf.zoom * 1.5;
                  return h.rects.map((rect, i) => (
                    <div
                      key={`${h.id}-${i}`}
                      className="highlight-overlay"
                      style={{
                        left: `${rect.x}px`,
                        top: `${rect.y}px`,
                        width: `${rect.width}px`,
                        height: `${rect.height}px`,
                        backgroundColor: h.color,
                      }}
                    />
                  ));
                })}

              {/* Freehand Strokes - SVG overlay */}
              <svg
                className="freehand-overlay"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: canvasRef.current?.style.width || '100%',
                  height: canvasRef.current?.style.height || '100%',
                  pointerEvents: 'none',
                }}
              >
                {freehandStrokes
                  .filter(s => s.page === pdf.currentPage)
                  .map((stroke, i) => {
                    const dpr = window.devicePixelRatio;
                    const points = stroke.points.map(p =>
                      `${p.x / dpr},${p.y / dpr}`
                    ).join(' ');
                    return (
                      <polyline
                        key={i}
                        points={points}
                        fill="none"
                        stroke={stroke.color}
                        strokeWidth={stroke.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                {/* Current stroke being drawn */}
                {currentTool === "draw" && currentStroke.length > 1 && (
                  <polyline
                    points={currentStroke.map(p => {
                      const dpr = window.devicePixelRatio;
                      return `${p.x / dpr},${p.y / dpr}`;
                    }).join(' ')}
                    fill="none"
                    stroke={drawColor}
                    strokeWidth={drawWidth}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>

              {/* Sticky Notes */}
              {stickyNotes
                .filter(n => n.page === pdf.currentPage)
                .map(note => {
                  const scale = pdf.zoom * 1.5 * window.devicePixelRatio;
                  return (
                    <div
                      key={note.id}
                      className={`sticky-note ${note.isOpen ? '' : 'sticky-note-collapsed'}`}
                      style={{
                        left: `${note.x / scale}px`,
                        top: `${note.y / scale}px`,
                        '--note-color': note.color,
                      } as React.CSSProperties}
                    >
                      {note.isOpen ? (
                        <>
                          <div className="sticky-note-header">
                            <button onClick={() => updateStickyNote(note.id, { isOpen: false })} title="Collapse"><Icon path={mdiMinus} size={0.6} /></button>
                            <button onClick={() => deleteStickyNote(note.id)} title="Delete"><Icon path={mdiClose} size={0.6} /></button>
                          </div>
                          <textarea
                            value={note.text}
                            onChange={(e) => updateStickyNote(note.id, { text: e.target.value })}
                            placeholder="Add note..."
                            autoFocus={editingNoteId === note.id}
                          />
                        </>
                      ) : (
                        <div onClick={() => updateStickyNote(note.id, { isOpen: true })} title="Expand note">
                          <Icon path={mdiNoteOutline} size={0.7} />
                        </div>
                      )}
                    </div>
                  );
                })}
              {/* Text Annotations */}
              {textAnnotations
                .filter(ann => ann.page === pdf.currentPage)
                .map((ann, _index) => {
                  const actualIndex = textAnnotations.findIndex(a => a === ann);
                  const scale = pdf.zoom * 1.5;
                  return (
                    <div
                      key={`text-${actualIndex}`}
                      className="text-annotation"
                      style={{
                        left: `${ann.x / window.devicePixelRatio / scale}px`,
                        top: `${ann.y / window.devicePixelRatio / scale}px`,
                      }}
                    >
                      <input
                        type="text"
                        value={ann.text}
                        onChange={(e) => updateTextAnnotation(actualIndex, e.target.value)}
                        onFocus={() => setEditingTextIndex(actualIndex)}
                        onBlur={() => setEditingTextIndex(null)}
                        placeholder="Type here..."
                        style={{ fontSize: `${ann.fontSize}px` }}
                        autoFocus={editingTextIndex === actualIndex}
                      />
                      <button
                        className="text-delete"
                        onClick={() => deleteTextAnnotation(actualIndex)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              {/* Draggable Signatures */}
              {signatures
                .filter(sig => sig.page === pdf.currentPage)
                .map((sig, _index) => {
                  const actualIndex = signatures.findIndex(s => s === sig);
                  const scale = pdf.zoom * 1.5;
                  return (
                    <div
                      key={actualIndex}
                      className="signature-overlay"
                      style={{
                        left: `${sig.x / window.devicePixelRatio / scale}px`,
                        top: `${sig.y / window.devicePixelRatio / scale}px`,
                        width: `${sig.width / window.devicePixelRatio / scale}px`,
                        height: `${sig.height / window.devicePixelRatio / scale}px`,
                      }}
                      onMouseDown={(e) => handleSignatureDragStart(e, actualIndex)}
                    >
                      <img src={sig.dataUrl} alt="Signature" draggable={false} />
                      <button
                        className="sig-delete"
                        onClick={(e) => { e.stopPropagation(); deleteSignature(actualIndex); }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              {/* Image Annotations */}
              {imageAnnotations
                .filter(img => img.page === pdf.currentPage)
                .map((img) => {
                  const scale = pdf.zoom * 1.5;
                  return (
                    <div
                      key={img.id}
                      className="image-annotation-overlay"
                      style={{
                        left: `${img.x / window.devicePixelRatio / scale}px`,
                        top: `${img.y / window.devicePixelRatio / scale}px`,
                        width: `${img.width / window.devicePixelRatio / scale}px`,
                        height: `${img.height / window.devicePixelRatio / scale}px`,
                      }}
                    >
                      <img src={img.dataUrl} alt="Inserted image" draggable={false} />
                      <button
                        className="img-delete"
                        onClick={(e) => { e.stopPropagation(); deleteImage(img.id); }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              {/* Link Annotations */}
              {linkAnnotations
                .filter(link => link.page === pdf.currentPage)
                .map((link) => {
                  const scale = pdf.zoom * 1.5;
                  return (
                    <div
                      key={link.id}
                      className="link-annotation-overlay"
                      style={{
                        left: `${link.x / window.devicePixelRatio / scale}px`,
                        top: `${link.y / window.devicePixelRatio / scale}px`,
                        width: `${link.width / window.devicePixelRatio / scale}px`,
                        height: `${link.height / window.devicePixelRatio / scale}px`,
                      }}
                      onClick={() => window.open(link.url, "_blank")}
                      title={link.url}
                    >
                      <button
                        className="link-delete"
                        onClick={(e) => { e.stopPropagation(); deleteLink(link.id); }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
            </div>
            ) : (
              <div className={`multipage-view ${viewMode}`}>
                {Array.from({ length: pdf.totalPages }, (_, index) => index + 1).map((pageNum) => (
                  <PDFPageView
                    key={`${activeTabId}-${pageNum}-${pdf.zoom}`}
                    doc={pdf.doc!}
                    pageNum={pageNum}
                    zoom={pdf.zoom}
                    currentTool={currentTool}
                    active={pdf.currentPage === pageNum}
                    onActivate={(activePage) => {
                      if (activePage !== pdf.currentPage) {
                        updateCurrentTab({ currentPage: activePage });
                      }
                    }}
                    onTextSelection={handleTextSelection}
                  />
                ))}
              </div>
            )
          ) : (
            <div className="empty-state">
              <img src="/logo.png" alt="Viridian Leaf" className="app-logo" />
              <h2>Viridian Leaf</h2>
              <p>A free, lightweight PDF viewer and editor</p>
              <button onClick={() => openFile()}>Open PDF</button>
              <p className="hint">Ctrl+O to open • No bloatware • No subscriptions</p>
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      {!isFullScreen && (
      <div className="statusbar">
        {pdf.fileName ? (
          <>
            <span>{pdf.fileName}</span>
            <span className="statusbar-separator">|</span>
            <span>Page {pdf.currentPage} of {pdf.totalPages}</span>
            <span className="statusbar-separator">|</span>
            <span>{Math.round(pdf.zoom * 100)}%</span>
            {redactions.length > 0 && (
              <>
                <span className="statusbar-separator">|</span>
                <span>{redactions.length} redaction(s)</span>
              </>
            )}
          </>
        ) : (
          <span>Ready - Open a PDF to get started</span>
        )}
        <span className="statusbar-spacer" />
        <span className="company">Viridian Intelligence Ltd. UK</span>
      </div>
      )}

      {/* About Dialog */}
      {showAbout && (
        <div className="modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <img src="/logo.png" alt="Viridian Leaf" className="modal-logo" />
            <h1>Viridian Leaf</h1>
            <p className="version">Version 1.0.0</p>
            <p className="company-name">Viridian Intelligence Ltd. UK</p>
            <p className="license">Licensed under MIT License</p>
            <p className="tagline">No bloatware. No subscriptions. Just PDFs.</p>
            <a
              href="https://www.perspiqua.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="website-link"
            >
              www.perspiqua.com
            </a>
            <button onClick={() => setShowAbout(false)}>Close</button>
          </div>
        </div>
      )}

      {/* Signature Pad Modal */}
      {showSignaturePad && (
        <div className="modal-overlay" onClick={() => setShowSignaturePad(false)}>
          <div className="modal signature-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Draw Your Signature</h2>
            <canvas
              ref={signatureCanvasRef}
              width={400}
              height={150}
              className="signature-canvas"
              onMouseDown={handleSignatureDrawStart}
              onMouseMove={handleSignatureDrawMove}
              onMouseUp={handleSignatureDrawEnd}
              onMouseLeave={handleSignatureDrawEnd}
            />
            <div className="signature-buttons">
              <button onClick={clearSignaturePad}>Clear</button>
              <button onClick={() => applySignature(false)}>Apply</button>
              <button onClick={() => applySignature(true)}>Apply & Save</button>
              <button onClick={() => setShowSignaturePad(false)}>Cancel</button>
            </div>

            {savedSignatures.length > 0 && (
              <div className="saved-signatures">
                <h3>Saved Signatures - Click to Place</h3>
                <div className="saved-signatures-list">
                  {savedSignatures.map((sig, i) => (
                    <div key={i} className="saved-signature-item">
                      <img src={sig} alt={`Saved ${i + 1}`} onClick={() => startPlaceSignature(sig)} title="Click to place on document" />
                      <button className="delete-sig" onClick={() => deleteSavedSignature(i)}><Icon path={mdiClose} size={0.6} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button className="load-image-btn" onClick={loadSignatureForCrop}>
              Load & Crop Signature Image...
            </button>
          </div>
        </div>
      )}

      {/* OCR Result Modal */}
      {showOcrResult && (
        <div className="modal-overlay" onClick={() => setShowOcrResult(false)}>
          <div className="modal ocr-modal" onClick={(e) => e.stopPropagation()}>
            <h2>OCR Result</h2>
            <textarea
              className="ocr-result"
              value={ocrText}
              readOnly
              rows={15}
            />
            <div className="ocr-buttons">
              <button onClick={async () => {
                await navigator.clipboard.writeText(ocrText);
                await message("Text copied to clipboard", { title: "Copied" });
              }}>Copy All</button>
              <button onClick={() => setShowOcrResult(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* OCR Loading Indicator */}
      {isOcrRunning && (
        <div className="modal-overlay">
          <div className="modal">
            <h2>Running OCR...</h2>
            <p>Please wait while text is being extracted from the page.</p>
          </div>
        </div>
      )}

      {/* Merge PDFs Modal */}
      {showMergeModal && (
        <div className="modal-overlay" onClick={() => { setShowMergeModal(false); setMergeFiles([]); }}>
          <div className="modal merge-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Merge PDFs</h2>
            <p>Drag to reorder files. Files will be merged in this order.</p>
            <div className="merge-file-list">
              {mergeFiles.map((file, index) => (
                <div
                  key={index}
                  className={`merge-file-item ${draggedMergeIndex === index ? 'dragging' : ''}`}
                  draggable
                  onDragStart={() => setDraggedMergeIndex(index)}
                  onDragEnd={() => setDraggedMergeIndex(null)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (draggedMergeIndex !== null && draggedMergeIndex !== index) {
                      moveMergeFile(draggedMergeIndex, index);
                      setDraggedMergeIndex(index);
                    }
                  }}
                >
                  <span className="merge-file-number">{index + 1}</span>
                  <span className="merge-file-name" title={file}>
                    {file.split(/[/\\]/).pop()}
                  </span>
                  <button
                    className="merge-file-up"
                    onClick={() => index > 0 && moveMergeFile(index, index - 1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    <Icon path={mdiArrowUp} size={0.6} />
                  </button>
                  <button
                    className="merge-file-down"
                    onClick={() => index < mergeFiles.length - 1 && moveMergeFile(index, index + 1)}
                    disabled={index === mergeFiles.length - 1}
                    title="Move down"
                  >
                    <Icon path={mdiArrowDown} size={0.6} />
                  </button>
                  <button
                    className="merge-file-remove"
                    onClick={() => removeMergeFile(index)}
                    title="Remove"
                  >
                    <Icon path={mdiClose} size={0.6} />
                  </button>
                </div>
              ))}
            </div>
            <div className="merge-buttons">
              <button onClick={addMoreMergeFiles}>Add More Files...</button>
              <div className="merge-buttons-right">
                <button onClick={() => { setShowMergeModal(false); setMergeFiles([]); }}>Cancel</button>
                <button
                  onClick={executeMerge}
                  disabled={mergeFiles.length < 2}
                  className="primary"
                >
                  Merge {mergeFiles.length} PDFs
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Watermark Modal */}
      {showWatermarkModal && (
        <div className="modal-overlay" onClick={() => setShowWatermarkModal(false)}>
          <div className="modal watermark-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Watermark</h2>
            <div className="modal-form">
              <label>
                Text:
                <input
                  type="text"
                  value={watermarkConfig.text}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, text: e.target.value })}
                  placeholder="CONFIDENTIAL"
                />
              </label>
              <label>
                Font Size:
                <input
                  type="number"
                  value={watermarkConfig.fontSize}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, fontSize: Number(e.target.value) })}
                  min={12}
                  max={200}
                />
              </label>
              <label>
                Color:
                <input
                  type="color"
                  value={watermarkConfig.color}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, color: e.target.value })}
                />
              </label>
              <label>
                Opacity:
                <input
                  type="range"
                  value={watermarkConfig.opacity}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, opacity: Number(e.target.value) })}
                  min={0.1}
                  max={1}
                  step={0.1}
                />
                <span>{Math.round(watermarkConfig.opacity * 100)}%</span>
              </label>
              <label>
                Angle:
                <input
                  type="number"
                  value={watermarkConfig.angle}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, angle: Number(e.target.value) })}
                  min={-90}
                  max={90}
                />
              </label>
              <label>
                Position:
                <select
                  value={watermarkConfig.position}
                  onChange={(e) => setWatermarkConfig({ ...watermarkConfig, position: e.target.value as "center" | "diagonal" | "tile" })}
                >
                  <option value="center">Center</option>
                  <option value="diagonal">Diagonal</option>
                  <option value="tile">Tile (Repeat)</option>
                </select>
              </label>
            </div>
            <div className="modal-buttons">
              <button onClick={() => setShowWatermarkModal(false)}>Cancel</button>
              <button onClick={applyWatermark} className="primary">Apply Watermark</button>
            </div>
          </div>
        </div>
      )}

      {/* Header/Footer Modal */}
      {showHeaderFooterModal && (
        <div className="modal-overlay" onClick={() => setShowHeaderFooterModal(false)}>
          <div className="modal header-footer-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Header & Footer</h2>
            <p className="modal-hint">Use {"{page}"}, {"{total}"}, {"{date}"} for dynamic values</p>
            <div className="modal-form header-footer-form">
              <div className="header-section">
                <h3>Header</h3>
                <div className="three-col">
                  <input
                    type="text"
                    placeholder="Left"
                    value={headerFooterConfig.headerLeft}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, headerLeft: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Center"
                    value={headerFooterConfig.headerCenter}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, headerCenter: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Right"
                    value={headerFooterConfig.headerRight}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, headerRight: e.target.value })}
                  />
                </div>
              </div>
              <div className="footer-section">
                <h3>Footer</h3>
                <div className="three-col">
                  <input
                    type="text"
                    placeholder="Left"
                    value={headerFooterConfig.footerLeft}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, footerLeft: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Center"
                    value={headerFooterConfig.footerCenter}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, footerCenter: e.target.value })}
                  />
                  <input
                    type="text"
                    placeholder="Right"
                    value={headerFooterConfig.footerRight}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, footerRight: e.target.value })}
                  />
                </div>
              </div>
              <div className="options-row">
                <label>
                  <input
                    type="checkbox"
                    checked={headerFooterConfig.includePageNumbers}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, includePageNumbers: e.target.checked })}
                  />
                  Include page numbers in footer center
                </label>
              </div>
              <div className="options-row">
                <label>
                  Font Size:
                  <input
                    type="number"
                    value={headerFooterConfig.fontSize}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, fontSize: Number(e.target.value) })}
                    min={6}
                    max={24}
                    style={{ width: 60 }}
                  />
                </label>
                <label>
                  Pages:
                  <input
                    type="number"
                    value={headerFooterConfig.startPage}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, startPage: Number(e.target.value) })}
                    min={1}
                    placeholder="Start"
                    style={{ width: 60 }}
                  />
                  to
                  <input
                    type="number"
                    value={headerFooterConfig.endPage || ""}
                    onChange={(e) => setHeaderFooterConfig({ ...headerFooterConfig, endPage: Number(e.target.value) || 0 })}
                    min={0}
                    placeholder="End (0=all)"
                    style={{ width: 60 }}
                  />
                </label>
              </div>
            </div>
            <div className="modal-buttons">
              <button onClick={() => setShowHeaderFooterModal(false)}>Cancel</button>
              <button onClick={applyHeaderFooter} className="primary">Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* Bookmark Modal */}
      {showBookmarkModal && (
        <div className="modal-overlay" onClick={() => setShowBookmarkModal(false)}>
          <div className="modal bookmark-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add Bookmark</h2>
            <p>Add a bookmark for page {pdf.currentPage}</p>
            <div className="modal-form">
              <label>
                Bookmark Title:
                <input
                  type="text"
                  value={newBookmarkTitle}
                  onChange={(e) => setNewBookmarkTitle(e.target.value)}
                  placeholder="Enter bookmark name..."
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addCustomBookmark();
                    if (e.key === "Escape") setShowBookmarkModal(false);
                  }}
                />
              </label>
            </div>
            {customBookmarks.length > 0 && (
              <div className="existing-bookmarks">
                <h3>Your Bookmarks</h3>
                <div className="bookmark-list">
                  {customBookmarks.map((bm) => (
                    <div key={bm.id} className="bookmark-list-item">
                      <span onClick={() => { goToPage(bm.page); setShowBookmarkModal(false); }}>
                        {bm.title} <small>(p.{bm.page})</small>
                      </span>
                      <button onClick={() => deleteCustomBookmark(bm.id)} title="Delete"><Icon path={mdiClose} size={0.5} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="modal-buttons">
              <button onClick={() => setShowBookmarkModal(false)}>Cancel</button>
              <button onClick={addCustomBookmark} className="primary" disabled={!newBookmarkTitle.trim()}>
                Add Bookmark
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Signature Crop Modal */}
      {showCropModal && cropImageSrc && (
        <div className="modal-overlay" onClick={() => setShowCropModal(false)}>
          <div className="modal crop-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Crop Signature</h2>
            <p>Draw a rectangle to select the signature area</p>
            <div className="crop-container">
              <canvas
                ref={cropCanvasRef}
                width={400}
                height={300}
                className="crop-canvas"
                onMouseDown={handleCropMouseDown}
                onMouseMove={handleCropMouseMove}
                onMouseUp={handleCropMouseUp}
                onMouseLeave={handleCropMouseUp}
              />
              <div
                className="crop-selection"
                style={{
                  left: cropRect.x,
                  top: cropRect.y,
                  width: cropRect.width,
                  height: cropRect.height,
                }}
              />
            </div>
            <div className="crop-buttons">
              <button onClick={applyCrop}>Crop & Use</button>
              <button onClick={() => setShowCropModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Find Bar */}
      {showFindBar && (
        <div className="find-bar-container">
          <div className="find-bar">
            <input
              type="text"
              placeholder="Find in document..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") findTextInPDF();
                if (e.key === "Escape") closeFindBar();
              }}
              autoFocus
            />
            <button onClick={findTextInPDF}>Find</button>
            <button onClick={goToPrevResult} disabled={searchResults.length === 0}><Icon path={mdiChevronLeft} size={0.7} /></button>
            <button onClick={goToNextResult} disabled={searchResults.length === 0}><Icon path={mdiChevronRight} size={0.7} /></button>
            {searchResults.length > 0 && (
              <span className="find-count">
                {currentSearchIndex + 1} of {searchResults.length}
              </span>
            )}
            {searchResults.length === 0 && searchText && (
              <span className="find-count no-results">No results</span>
            )}
            <button onClick={closeFindBar} className="find-close"><Icon path={mdiClose} size={0.7} /></button>
          </div>
          <div className="find-options">
            <label>
              <input
                type="checkbox"
                checked={searchCaseSensitive}
                onChange={(e) => setSearchCaseSensitive(e.target.checked)}
              />
              Case sensitive
            </label>
            <label>
              <input
                type="checkbox"
                checked={searchWholeWord}
                onChange={(e) => setSearchWholeWord(e.target.checked)}
              />
              Whole word
            </label>
          </div>
          {searchResults.length > 0 && (
            <div className="search-results-panel">
              {searchResults.map((result, i) => (
                <div
                  key={i}
                  className={`search-result-item ${i === currentSearchIndex ? 'active' : ''}`}
                  onClick={() => {
                    setCurrentSearchIndex(i);
                    goToSearchResult(i);
                  }}
                >
                  <span className="result-page">Page {result.page}</span>
                  <span className="result-context">{result.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tool indicators */}
      {currentTool === "sign" && pendingSignature && (
        <div className="tool-floating-indicator">
          Click on the document to place signature
          <button onClick={() => { setPendingSignature(null); setCurrentTool("none"); }}>Cancel</button>
        </div>
      )}
      {currentTool === "text" && (
        <div className="tool-floating-indicator">
          Click on the document to add text
          <button onClick={() => setCurrentTool("none")}>Cancel</button>
        </div>
      )}
      {currentTool === "highlight" && (
        <div className="tool-floating-indicator highlight-indicator">
          Select text to highlight
          <button onClick={() => setCurrentTool("none")}>Cancel</button>
        </div>
      )}
      {currentTool === "note" && (
        <div className="tool-floating-indicator note-indicator">
          Click on the document to add a sticky note
          <button onClick={() => setCurrentTool("none")}>Cancel</button>
        </div>
      )}
      {currentTool === "draw" && (
        <div className="tool-floating-indicator draw-indicator">
          Draw on the document (freehand)
          <button onClick={() => setCurrentTool("none")}>Cancel</button>
        </div>
      )}
      {currentTool === "image" && pendingImage && (
        <div className="tool-floating-indicator">
          Click on the document to place the image
          <button onClick={() => { setPendingImage(null); setCurrentTool("none"); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

export default App;
