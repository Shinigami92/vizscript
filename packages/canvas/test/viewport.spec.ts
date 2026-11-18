import { describe, expect, it } from 'vitest';
import { CAMERA_MOTION_MS } from '../src/graph-view-constants';
import {
  fitAll,
  focusCamera,
  initialCamera,
  revealCamera,
  Viewport,
} from '../src/viewport';

const BOUNDS = { x: 100, y: 100, width: 200, height: 100 };

describe('camera targets', () => {
  it('fits all up to 100 %', () => {
    expect(fitAll(BOUNDS, 4000, 4000).zoom).toBe(1);
    expect(fitAll(BOUNDS, 296, 1000).zoom).toBeCloseTo(1);
    expect(fitAll(BOUNDS, 148, 1000).zoom).toBeLessThan(1);
  });

  it('starts at the top left when fitting everything is unreadable', () => {
    expect(initialCamera(BOUNDS, 800, 600)).toEqual(fitAll(BOUNDS, 800, 600));
    const wide = { x: 0, y: 0, width: 10_000, height: 100 };
    expect(initialCamera(wide, 800, 600)).toEqual({
      zoom: 0.85,
      x: -48 / 0.85,
      y: -48 / 0.85,
    });
  });

  it('focuses at a readable zoom, centered', () => {
    const camera = focusCamera(BOUNDS, { x: 0, y: 0, zoom: 0.2 }, 800, 600);
    expect(camera.zoom).toBe(0.8);
    // The center of the bounds is the center of the view.
    expect(camera.x + 400 / 0.8).toBeCloseTo(200);
    expect(camera.y + 300 / 0.8).toBeCloseTo(150);
  });

  it('reveals only what is out of view, zooming out if needed', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    expect(revealCamera(BOUNDS, camera, 800, 600)).toBeNull();

    const away = { ...BOUNDS, x: 2000 };
    expect(revealCamera(away, camera, 800, 600)).toEqual({
      zoom: 1,
      x: 2100 - 400,
      y: 150 - 300,
    });

    const huge = { x: 2000, y: 0, width: 3000, height: 100 };
    expect(revealCamera(huge, camera, 800, 600)?.zoom).toBeLessThan(1);
  });
});

describe('Viewport', () => {
  it('frames below the notices covering its top', () => {
    const viewport = new Viewport();
    viewport.width = 800;
    viewport.height = 600;
    viewport.set({ x: 0, y: 0, zoom: 1 });
    viewport.top = 100;
    const fit = viewport.framed((_, width, height) =>
      fitAll(BOUNDS, width, height)
    );
    // Centered in the 500 px below the notice, not in all 600 px.
    const top = (BOUNDS.y - fit.y) * fit.zoom;
    const bottom = 600 - (BOUNDS.y + BOUNDS.height - fit.y) * fit.zoom;
    expect(top - 100).toBeCloseTo(bottom);
  });

  it('reveals nodes hidden under the notices', () => {
    const viewport = new Viewport();
    viewport.width = 800;
    viewport.height = 600;
    // BOUNDS is in view, but its top 50 px are under a 150 px notice.
    viewport.set({ x: 0, y: 0, zoom: 1 });
    const reveal = (): ReturnType<typeof revealCamera> =>
      viewport.framed((camera, width, height) =>
        revealCamera(BOUNDS, camera, width, height)
      );
    expect(reveal()).toBeNull();
    viewport.top = 150;
    const to = reveal();
    expect(to && (BOUNDS.y - to.y) * to.zoom).toBeGreaterThan(150);
  });

  it('keeps at least half the view for the graph', () => {
    const viewport = new Viewport();
    viewport.width = 800;
    viewport.height = 600;
    viewport.top = 1000;
    const fit = viewport.framed((_, width, height) =>
      fitAll(BOUNDS, width, height)
    );
    expect((BOUNDS.y - fit.y) * fit.zoom).toBeGreaterThanOrEqual(300);
  });

  it('eases to a camera and reports while it moves', () => {
    const viewport = new Viewport();
    viewport.width = 800;
    viewport.height = 600;
    viewport.set({ x: 0, y: 0, zoom: 1 });
    expect(viewport.ease({ x: 100, y: 0, zoom: 1 }, 1000)).toBe(true);
    expect(viewport.target()).toEqual({ x: 100, y: 0, zoom: 1 });

    expect(viewport.step(1000 + CAMERA_MOTION_MS / 2)).toEqual({
      moved: true,
      running: true,
    });
    expect(viewport.camera.x).toBeGreaterThan(50);
    expect(viewport.camera.x).toBeLessThan(100);

    expect(viewport.step(1000 + CAMERA_MOTION_MS)).toEqual({
      moved: true,
      running: false,
    });
    expect(viewport.camera).toEqual({ x: 100, y: 0, zoom: 1 });
    expect(viewport.step(5000)).toEqual({ moved: false, running: false });
  });

  it('sets the camera at once before it has a size', () => {
    const viewport = new Viewport();
    expect(viewport.ease({ x: 5, y: 5, zoom: 2 }, 0)).toBe(false);
    expect(viewport.camera).toEqual({ x: 5, y: 5, zoom: 2 });
    expect(viewport.tween).toBeNull();
  });

  it('zooms around the center of the view, from where a move ends', () => {
    const viewport = new Viewport();
    viewport.width = 800;
    viewport.height = 600;
    viewport.set({ x: 0, y: 0, zoom: 1 });
    viewport.ease({ x: 100, y: 100, zoom: 1 }, 0);
    expect(viewport.zoomedBy(2)).toEqual({ x: 300, y: 250, zoom: 2 });
  });
});
