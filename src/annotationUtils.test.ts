import { describe, expect, it } from "vitest";
import {
  appendStrokePoint,
  canvasPointToCssPoint,
  canvasPointToPdfPoint,
  createFreehandStroke,
  highlightRectToPdfRect,
  parseHexRgb,
  requiresSinglePageOverlay,
  stickyNoteOverlayPosition,
  stickyNoteToPdfRect,
} from "./annotationUtils";

describe("annotation utilities", () => {
  it("detects tools that need the single-page overlay", () => {
    expect(requiresSinglePageOverlay("highlight")).toBe(true);
    expect(requiresSinglePageOverlay("note")).toBe(true);
    expect(requiresSinglePageOverlay("draw")).toBe(true);
    expect(requiresSinglePageOverlay("none")).toBe(false);
    expect(requiresSinglePageOverlay("select")).toBe(false);
  });

  it("parses hex colors for pdf-lib rgb values", () => {
    expect(parseHexRgb("#ffff00")).toEqual([1, 1, 0]);
    expect(parseHexRgb("000000")).toEqual([0, 0, 0]);
    expect(parseHexRgb("#bad")).toEqual([0, 0, 0]);
  });

  it("keeps freehand stroke points immutable and ignores single-point strokes", () => {
    const firstPoint = { x: 10, y: 20 };
    const points = [firstPoint];
    const nextPoints = appendStrokePoint(points, { x: 15, y: 25 });

    expect(points).toEqual([firstPoint]);
    expect(nextPoints).toEqual([firstPoint, { x: 15, y: 25 }]);
    expect(createFreehandStroke(points, "#000000", 2, 1)).toBeNull();
    expect(createFreehandStroke(nextPoints, "#000000", 2, 1)).toEqual({
      points: nextPoints,
      color: "#000000",
      width: 2,
      page: 1,
    });
  });

  it("converts canvas points to CSS overlay coordinates using device pixel ratio only", () => {
    const point = { x: 300, y: 420 };

    expect(canvasPointToCssPoint(point, 2)).toEqual({ x: 150, y: 210 });
    expect(stickyNoteOverlayPosition(point, 2)).toEqual({ x: 150, y: 210 });
  });

  it("converts canvas points to PDF coordinates with zoom and inverted Y axis", () => {
    expect(canvasPointToPdfPoint({ x: 300, y: 420 }, 792, 1, 2)).toEqual({
      x: 100,
      y: 652,
    });
  });

  it("converts highlight rectangles from text-layer CSS pixels to PDF rectangles", () => {
    expect(highlightRectToPdfRect({ x: 30, y: 60, width: 150, height: 24 }, 792, 1)).toEqual({
      x: 20,
      y: 736,
      width: 100,
      height: 16,
    });
  });

  it("converts sticky note placement from canvas pixels to PDF rectangle bounds", () => {
    expect(stickyNoteToPdfRect({ x: 300, y: 420 }, 792, 1, 2)).toEqual({
      x: 100,
      y: 592,
      width: 106.66666666666667,
      height: 60,
    });
  });
});
