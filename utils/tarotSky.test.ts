import { describe, expect, it } from 'vitest';
import {
  CONSTELLATIONS,
  buildSkyDome,
  constellationPointDirection,
  continuousSkyPose,
  interpolateSkyPose,
  projectHemispherePoint,
  projectSkySegment,
  resolveNavigationPose,
  rotateSkyDirection,
  type SkyPose,
} from './tarotSky';

const ZERO: SkyPose = { yaw: 0, pitch: 0, roll: 0 };

const shapeKey = (definition: (typeof CONSTELLATIONS)[number]) => JSON.stringify({
  points: definition.points.map(({ x, y }) => [Number(x.toFixed(3)), Number(y.toFixed(3))]),
  lines: definition.lines,
});

describe('tarot sky constellations', () => {
  it('keeps at least twelve unique names and distinct star-chart geometries', () => {
    expect(CONSTELLATIONS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(CONSTELLATIONS.map((item) => item.name)).size).toBe(CONSTELLATIONS.length);
    expect(new Set(CONSTELLATIONS.map(shapeKey)).size).toBe(CONSTELLATIONS.length);
    const dome = buildSkyDome();
    expect(dome.map((item) => item.definition.name)).toEqual(CONSTELLATIONS.map((item) => item.name));
  });

  it('uses a seven-star dipper with a four-star bowl and a three-star handle', () => {
    const dipper = CONSTELLATIONS.find((item) => item.name === '北斗七星')!;
    expect(dipper.points).toHaveLength(7);
    expect(dipper.lines).toHaveLength(7);
    expect(dipper.lines).toContainEqual([3, 0]);
    expect(dipper.lines).toContainEqual([3, 4]);
    expect(dipper.lines).toContainEqual([4, 5]);
    expect(dipper.lines).toContainEqual([5, 6]);
    expect(Math.hypot(dipper.points[6].x - dipper.points[3].x, dipper.points[6].y - dipper.points[3].y))
      .toBeGreaterThan(0.3);
  });
});

describe('spherical tarot sky projection', () => {
  it.each([[1440, 900], [393, 852]])('projects dome points finitely at %ix%i', (width, height) => {
    const dome = buildSkyDome();
    for (const item of dome) {
      const point = projectHemispherePoint(rotateSkyDirection(item.anchor, ZERO), width, height);
      expect(point === null || (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.depth))).toBe(true);
    }
    expect(projectHemispherePoint({ x: 0, y: 0, z: 1 }, width, height)).toMatchObject({
      x: width / 2,
      y: height * 0.44,
    });
    expect(projectHemispherePoint({ x: 0, y: 0, z: -1 }, width, height)).toBeNull();
  });

  it('keeps local constellation points on the unit sphere', () => {
    const direction = constellationPointDirection(
      { x: 0.3, y: -0.2, z: Math.sqrt(0.87) },
      { x: 0.4, y: -0.3 },
      0.22,
      0.6,
    );
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 8);
  });

  it('slerps and clips lines at the horizon and viewport without non-finite points', () => {
    const paths = projectSkySegment(
      { x: 0.92, y: 0, z: 0.392 },
      { x: -0.92, y: 0, z: 0.392 },
      393,
      852,
      ZERO,
      32,
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.length).toBeGreaterThanOrEqual(2);
      for (const point of path) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(393);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(852);
      }
    }
  });
});

describe('bounded sky navigation attitude', () => {
  it('turns the dome gently over minutes and freezes under reduced motion', () => {
    expect(continuousSkyPose(210, ZERO, false).yaw).toBeCloseTo(Math.PI * 2, 8);
    expect(continuousSkyPose(210, ZERO, true)).toEqual(ZERO);
  });

  it('maps rapid navigation signals to bounded absolute targets rather than accumulating angles', () => {
    expect(resolveNavigationPose(0)).toEqual(ZERO);
    const poses = [1, 2, 3, 4, 5, 1000].map(resolveNavigationPose);
    for (const pose of poses) {
      expect(Math.abs(pose.yaw)).toBeLessThanOrEqual(0.15);
      expect(Math.abs(pose.pitch)).toBeLessThanOrEqual(0.06);
      expect(Math.abs(pose.roll)).toBeLessThanOrEqual(0.035);
    }
    expect(resolveNavigationPose(1000)).toEqual(resolveNavigationPose(1000));
  });

  it('smoothly approaches a new pose with a frame delta cap', () => {
    const target = resolveNavigationPose(3);
    const afterLongFrame = interpolateSkyPose(ZERO, target, 8, false);
    const afterNormalFrame = interpolateSkyPose(ZERO, target, 0.016, false);
    expect(afterLongFrame.yaw).toBeLessThanOrEqual(target.yaw);
    expect(Math.abs(afterLongFrame.yaw)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(afterNormalFrame.yaw)).toBeLessThan(Math.abs(target.yaw));
    expect(interpolateSkyPose(ZERO, target, 0.016, true)).toEqual(target);
  });
});
