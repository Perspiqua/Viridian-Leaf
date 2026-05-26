export type OverlayTool =
  | "redact"
  | "sign"
  | "text"
  | "highlight"
  | "note"
  | "draw"
  | "image"
  | "link";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const singlePageOverlayTools: OverlayTool[] = [
  "redact",
  "sign",
  "text",
  "highlight",
  "note",
  "draw",
  "image",
  "link",
];

export const requiresSinglePageOverlay = (tool: string) =>
  singlePageOverlayTools.includes(tool as OverlayTool);

export const parseHexRgb = (hex: string): [number, number, number] => {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return [0, 0, 0];

  return [
    parseInt(normalized.slice(0, 2), 16) / 255,
    parseInt(normalized.slice(2, 4), 16) / 255,
    parseInt(normalized.slice(4, 6), 16) / 255,
  ];
};

export const appendStrokePoint = (points: Point[], point: Point) => [...points, point];

export const createFreehandStroke = (
  points: Point[],
  color: string,
  width: number,
  page: number,
) => {
  if (points.length < 2) return null;

  return {
    points,
    color,
    width,
    page,
  };
};

export const canvasPointToCssPoint = (point: Point, devicePixelRatio: number): Point => ({
  x: point.x / devicePixelRatio,
  y: point.y / devicePixelRatio,
});

export const canvasPointToPdfPoint = (
  point: Point,
  pageHeight: number,
  zoom: number,
  devicePixelRatio: number,
): Point => {
  const scale = zoom * 1.5 * devicePixelRatio;
  return {
    x: point.x / scale,
    y: pageHeight - point.y / scale,
  };
};

export const highlightRectToPdfRect = (
  rect: Rect,
  pageHeight: number,
  zoom: number,
): Rect => {
  const scale = zoom * 1.5;
  return {
    x: rect.x / scale,
    y: pageHeight - (rect.y + rect.height) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
};

export const stickyNoteOverlayPosition = (
  point: Point,
  devicePixelRatio: number,
): Point => canvasPointToCssPoint(point, devicePixelRatio);

export const stickyNoteToPdfRect = (
  point: Point,
  pageHeight: number,
  zoom: number,
  devicePixelRatio: number,
  cssWidth = 160,
  cssHeight = 90,
): Rect => {
  const scale = zoom * 1.5 * devicePixelRatio;
  const cssScale = zoom * 1.5;
  const height = cssHeight / cssScale;

  return {
    x: point.x / scale,
    y: pageHeight - point.y / scale - height,
    width: cssWidth / cssScale,
    height,
  };
};
