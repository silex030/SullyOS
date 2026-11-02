// Tarot wiring guard (source-level, same style as pomodoroWiring.test.ts).
// vitest runs in pure Node without jsdom, so React screens cannot mount here.
// This only guards against the wiring being dropped: AppID registration,
// desktop icon, PhoneShell render path, safe-area self-handling, and the
// IndexedDB store + accessors for reading history.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(
  fileURLToPath(new URL(rel, import.meta.url)),
  'utf8',
);

const types = read('../types.ts');
const constants = read('../constants.tsx');
const shell = read('../components/PhoneShell.tsx');
const safeArea = read('./safeAreaApps.ts');
const db = read('./db.ts');
const tarotApp = read('../apps/TarotApp.tsx');
const tarotLibrary = read('../apps/tarot/LibraryView.tsx');
const tarotRitual = read('../apps/tarot/RitualView.tsx');
const tarotReading = read('../apps/tarot/ReadingView.tsx');
const tarotDome = read('../apps/tarot/TarotDomeCanvas.tsx');
const tarotBokeh = read('../apps/tarot/TarotBokeh.tsx');
const tarotSkyShader = read('../apps/tarot/TarotSkyShader.tsx');

describe('tarot app registration', () => {
  it('AppID has Tarot', () => {
    expect(types).toContain("Tarot = 'tarot'");
  });

  it('desktop has Tarot icon and entry', () => {
    expect(constants).toContain('Tarot:');
    expect(constants).toContain('AppID.Tarot');
  });

  it('PhoneShell lazy-loads, maps and renders TarotApp', () => {
    expect(shell).toContain("import('../apps/TarotApp')");
    expect(shell).toContain('[AppID.Tarot]: TarotApp');
    expect(shell).toContain('case AppID.Tarot: return <TarotApp />;');
  });

  it('Tarot handles its own safe area', () => {
    expect(safeArea).toContain('AppID.Tarot');
  });
});

describe('tarot reading store', () => {
  it('db has the tarot_readings store and accessors', () => {
    expect(db).toContain('tarot_readings');
    expect(db).toContain('getTarotReadings');
    expect(db).toContain('saveTarotReading');
    expect(db).toContain('deleteTarotReading');
  });
});

describe('tarot sky navigation wiring', () => {
  it('keeps one continuous dome instance outside the remounted tab content', () => {
    expect(tarotApp).toContain('<TarotDomeCanvas navigationSignal={navigationSignal} />');
    expect(tarotApp.indexOf('<TarotDomeCanvas')).toBeLessThan(tarotApp.indexOf('key={tab}'));
    expect(tarotApp).toContain('if (tab !== id) signalSkyNavigation();');
    expect(tarotApp).toContain('onSkyNavigation={signalSkyNavigation}');
  });

  it('keeps foreground bokeh spatially stable outside per-tab sky parallax', () => {
    expect(tarotApp).toContain('<TarotBokeh />');
    expect(tarotApp).not.toContain('<TarotBokeh parallaxIndex=');
    expect(tarotBokeh).not.toContain('parallaxIndex');
    expect(tarotBokeh).not.toContain('offsetPx');
    expect(tarotBokeh).not.toContain('driftVx');
    expect(tarotBokeh).not.toContain('requestAnimationFrame');
  });

  it('signals only known internal detail and reading transitions', () => {
    expect(tarotLibrary).toContain('onSkyNavigation?.()');
    expect(tarotApp).toContain('signalSkyNavigation();');
    expect(tarotRitual).toContain('onSkyNavigation?.()');
    expect(tarotReading).toContain('onSkyNavigation?.()');
  });

  it('updates reduced-motion preference live while retaining a static sky', () => {
    expect(tarotDome).toContain("motionQuery.addEventListener('change', onMotionChange)");
    expect(tarotDome).toContain('drawStaticRef.current()');
    expect(tarotDome).toContain('document.addEventListener(\'visibilitychange\', onVisibility)');
    expect(tarotSkyShader).toContain("motionQuery.addEventListener('change', onMotionChange)");
  });
});
