/**
 * room3d · Room3DHome
 * 可交互的 3D 小家园（自制几何家具 + 自研轨道镜头）。
 *
 * 纯 props + 模块端口：所有持久化走 storage: StorageLike，
 * 人物标记走 chibi: ChibiMarker（只读 adapter 产出）。
 * three 仅在 effect 内动态 import，首屏/单测不碰 WebGL。
 *
 * 性能与生命周期：
 * - DPR 上限 1.75；rAF 按 60fps 节流；页面隐藏自动暂停。
 * - WebGL 不可用（或 forceFallback）→ 明确提示 + fallback2D 插槽，
 *   绝不挡住既有 2D 小窝。
 * - 卸载时释放 renderer / geometry / material / texture / listeners。
 * - reduced-motion 动态生效（matchMedia 监听）：关闭待机浮动。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_ORBIT,
  applyDrag,
  applyZoom,
  prefersReducedMotion,
  resetOrbit,
  type OrbitState,
} from './camera';
import type { ChibiMarker } from './chibiAdapter';
import type * as T3 from 'three';
import {
  FURNITURE_CATALOG,
  createDefaultLayout,
  makeFurnitureId,
  moveItemClamped,
  rotateItem,
  spotPoseForIndex,
} from './furniture';
import { createRoom3DStore, type Room3DLoadStatus, type StorageLike } from './storage';
import type { CrossDocMutex } from './mutex';
import { UiOperationLeaseManager, type UiOperationLease } from '../shared/uiOperationLease';
import {
  ROOM3D_BOUNDS,
  ROOM3D_MAX_ITEMS,
  type FurnitureKind,
  type Room3DFurnitureItem,
  type Room3DStateV1,
} from './types';

export interface Room3DHomeProps {
  charId: string;
  storage: StorageLike;
  chibi: ChibiMarker;
  /**
   * 跨文档互斥能力（redesign-v1 写协议）：
   * - 不传 → getDefaultMutex()（浏览器 Web Locks / Node 进程内单例）；
   * - 传 null → 无安全能力，保存一律被拒绝（fail closed）。
   * 测试跨 tab 场景时传入共享 mutex 实例。
   */
  mutex?: CrossDocMutex | null;
  /** preview/测试专用：强制走 WebGL 失败分支。生产永远不传。 */
  forceFallback?: boolean;
  /**
   * preview/测试专用：挂载后自动选中第一件家具，便于用真实 UI
   *（选中面板的方向键）做“移动→保存→重开”坐标验证。生产永远不传。
   */
  autoSelectFirst?: boolean;
  /**
   * preview/测试专用：每帧上报待机浮动状态 {bob, reduced}，
   * 用于验证运行中切换 reduced-motion 是否真正停止位移。生产永远不传。
   */
  motionProbe?: (info: { bob: number; reduced: boolean }) => void;
  /** 既有 2D 小窝插槽：3D 不可用时渲染它。 */
  fallback2D?: ReactNode;
  onSaved?: (state: Room3DStateV1) => void;
  onFallback?: (reason: string) => void;
}

type Status =
  | { phase: 'loading' }
  | { phase: 'ready'; notice?: string }
  | { phase: 'fallback'; reason: string };

const DPR_CAP = 1.75;
const GROUND_Y = 0;

export function Room3DHome({
  charId,
  storage,
  chibi,
  mutex,
  forceFallback = false,
  autoSelectFirst = false,
  motionProbe,
  fallback2D,
  onSaved,
  onFallback,
}: Room3DHomeProps): ReactNode {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const mutexOpt = mutex === undefined ? {} : { mutex };
  const storeRef = useRef(createRoom3DStore(storage, mutexOpt));
  storeRef.current = createRoom3DStore(storage, mutexOpt);
  const [items, setItems] = useState<Room3DFurnitureItem[]>(() => {
    const loaded = createRoom3DStore(storage).load(charId);
    return loaded ? loaded.items : createDefaultLayout();
  });
  // 槽位元信息：rev（opaque 并发期望）+ 读取状态 + 原始字节。
  // charId/storage 切换即重载，同一 mounted 实例 A→B→A 不串档；
  // corrupt/read-error 只展示恢复 UI，绝不自动覆写。
  const [slotMeta, setSlotMeta] = useState<{
    status: Room3DLoadStatus;
    rev: string | null;
    raw: string | null;
  }>(() => {
    const meta = createRoom3DStore(storage).loadMeta(charId);
    return { status: meta.status, rev: meta.rev, raw: meta.raw };
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const slotMetaRef = useRef(slotMeta);
  slotMetaRef.current = slotMeta;
  // preview/测试专用自动选中的一次性标记（实际选中逻辑见槽位重载 effect 之后）。
  const autoSelectedRef = useRef(false);
  const [status, setStatus] = useState<Status>({ phase: 'loading' });
  const [orbitLabel, setOrbitLabel] = useState<string>('');
  const chibiImg = chibi.kind === 'sprite' ? chibi.img : '';

  // 角色/端口切换：重载该槽 items + rev + 状态，清空选中。
  // UI 操作租约（operation-lease-v2 唯一协议）：slot 代次 + 操作序号 + 编辑版本。
  // save/recover 开始时 beginOperation 捕获租约；本地家具编辑 notifyLocalEdit。
  // 接纳唯一条件 isOperationCurrent；旧 saveEpoch/sameSlotAs 身份相等已废除。
  // mountedRef 仅用于避免卸载后 setState，绝不代替代次判定。
  const leaseRef = useRef<UiOperationLeaseManager | null>(null);
  if (!leaseRef.current) leaseRef.current = new UiOperationLeaseManager();
  const prevSlotRef = useRef<{ charId: string; storage: StorageLike } | null>(null);
  useEffect(() => {
    const prev = prevSlotRef.current;
    if (prev && (prev.charId !== charId || prev.storage !== storage)) {
      leaseRef.current!.rotateSlot();
    }
    prevSlotRef.current = { charId, storage };
    autoSelectedRef.current = false; // preview 自动选中随槽位一起重置
    const store = storeRef.current;
    const meta = store.loadMeta(charId);
    const next = { status: meta.status, rev: meta.rev, raw: meta.raw };
    // 槽位重载是新代次基线（非持久化 ack）：rotate 已清空已接纳指针，
    // 这里直接同步 ref，避免下一次保存读到上一 render 的旧 rev。
    slotMetaRef.current = next;
    setSlotMeta(next);
    setItems(meta.state ? meta.state.items : createDefaultLayout());
    setSelectedId(null);
  }, [charId, storage]);
  // preview/测试专用：槽位就绪且无选中时自动选中第一件（生产不传 autoSelectFirst）。
  // 声明在槽位重载 effect 之后，保证首挂载时重载先清空、这里再选中。
  // 注意：首挂载时初始 items 与重载后 items 是两套新 id（makeFurnitureId），
  // 因此按“当前选中 id 是否仍在 items 中”判定有效性，无效即纠正为第一件。
  useEffect(() => {
    if (!autoSelectFirst || items.length === 0) return;
    const valid =
      selectedId !== null && items.some((i) => i.id === selectedId);
    if (valid) {
      autoSelectedRef.current = true;
      return;
    }
    autoSelectedRef.current = true;
    setSelectedId(items[0].id);
  }, [autoSelectFirst, items, selectedId]);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      leaseRef.current!.invalidateForUnmount();
    };
  }, []);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // 本地编辑使已发出的旧 save 快照失效（operation-lease-v2 editRevision）。
  const markEdited = (): void => {
    leaseRef.current!.notifyLocalEdit();
  };
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const orbitRef = useRef<OrbitState>({ ...DEFAULT_ORBIT });
  const apiRef = useRef<{
    setOrbit: (o: OrbitState) => void;
    moveSelected: (dx: number, dz: number) => void;
  } | null>(null);
  const syncSceneRef = useRef<(() => void) | null>(null);
  // preview/测试探针走 ref，避免 prop 身份变化重建整个 3D 场景。
  const motionProbeRef = useRef(motionProbe);
  motionProbeRef.current = motionProbe;

  // React 状态（items/选中）变化后，把位姿同步进已建好的 three 场景。
  useEffect(() => {
    syncSceneRef.current?.();
  });

  // ---- 3D 场景生命周期 ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    if (forceFallback) {
      const reason = 'preview-forced-fallback';
      setStatus({ phase: 'fallback', reason });
      onFallback?.(reason);
      return;
    }
    let disposed = false;
    let appended: HTMLCanvasElement | null = null;
    let renderer: { dispose: () => void; forceContextLoss?: () => void } | null = null;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    const disposables: Array<{ dispose: () => void }> = [];
    const listeners: Array<
      [EventTarget, string, EventListener, AddEventListenerOptions?]
    > = [];
    const on = (
      t: EventTarget,
      type: string,
      fn: EventListener,
      opts?: AddEventListenerOptions,
    ): void => {
      t.addEventListener(type, fn, opts);
      listeners.push([t, type, fn, opts]);
    };

    (async () => {
      try {
        const probe = document.createElement('canvas');
        const gl =
          probe.getContext('webgl2') ?? probe.getContext('webgl');
        if (!gl) throw new Error('webgl-unavailable');
        const THREE: typeof import('three') = await import('three');
        if (disposed) return;

        const canvas = document.createElement('canvas');
        appended = canvas;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.touchAction = 'none';
        mount.appendChild(canvas);

        const rt = new THREE.WebGLRenderer({ canvas, antialias: true });
        renderer = rt as unknown as {
          dispose: () => void;
          forceContextLoss?: () => void;
        };
        rt.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#1c2230');

        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        const applyOrbit = (o: OrbitState): void => {
          const target = new THREE.Vector3(0, 0.8, 0);
          camera.position.set(
            target.x + o.radius * Math.sin(o.phi) * Math.sin(o.theta),
            target.y + o.radius * Math.cos(o.phi),
            target.z + o.radius * Math.sin(o.phi) * Math.cos(o.theta),
          );
          camera.lookAt(target);
        };
        applyOrbit(orbitRef.current);

        scene.add(new THREE.HemisphereLight('#fff4e0', '#3a4a63', 0.9));
        const dir = new THREE.DirectionalLight('#ffffff', 1.1);
        dir.position.set(5, 8, 4);
        scene.add(dir);

        // 地板 + 两面墙 + 网格
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(10, 10),
          new THREE.MeshStandardMaterial({ color: '#e8ded2' }),
        );
        floor.rotation.x = -Math.PI / 2;
        scene.add(floor);
        disposables.push(floor.geometry, floor.material as { dispose: () => void });
        const wallMat = new THREE.MeshStandardMaterial({ color: '#f2ece2' });
        const wallBack = new THREE.Mesh(new THREE.PlaneGeometry(10, 3.2), wallMat);
        wallBack.position.set(0, 1.6, -5);
        scene.add(wallBack);
        const wallLeft = new THREE.Mesh(new THREE.PlaneGeometry(10, 3.2), wallMat);
        wallLeft.rotation.y = Math.PI / 2;
        wallLeft.position.set(-5, 1.6, 0);
        scene.add(wallLeft);
        disposables.push(wallBack.geometry, wallLeft.geometry, wallMat);
        const grid = new THREE.GridHelper(10, 10, '#b9ac96', '#cfc3ad');
        grid.position.y = 0.01;
        scene.add(grid);
        disposables.push(grid.geometry, grid.material as { dispose: () => void });

        // 家具组（id → Group）
        const world = new THREE.Group();
        scene.add(world);
        const groups = new Map<string, T3.Group>();
        const lampLights: T3.PointLight[] = [];

        const buildItem = (item: Room3DFurnitureItem): T3.Group => {
          const def = FURNITURE_CATALOG[item.kind];
          const g = new THREE.Group();
          for (const part of def.parts) {
            let geo: T3.BufferGeometry;
            if (part.shape === 'box') {
              geo = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
            } else if (part.shape === 'cylinder') {
              geo = new THREE.CylinderGeometry(part.size[0], part.size[2], part.size[1], 20);
            } else if (part.shape === 'sphere') {
              geo = new THREE.SphereGeometry(part.size[0], 20, 14);
            } else {
              geo = new THREE.ConeGeometry(part.size[0], part.size[1], 20);
            }
            const mat = new THREE.MeshStandardMaterial({
              color: item.color ?? part.color,
              emissive: part.emissive ? (item.color ?? part.color) : '#000000',
              emissiveIntensity: part.emissive ? 0.9 : 0,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.set(part.offset[0], part.offset[1], part.offset[2]);
            mesh.userData['furnitureId'] = item.id;
            g.add(mesh);
            disposables.push(geo, mat);
          }
          if (item.kind === 'lamp') {
            const pl = new THREE.PointLight('#ffd9a0', 6, 7, 1.6);
            pl.position.set(0, 1.6, 0);
            g.add(pl);
            lampLights.push(pl);
          }
          g.position.set(item.pose.x, item.pose.y, item.pose.z);
          g.rotation.y = item.pose.rotY;
          g.scale.setScalar(item.pose.scale);
          return g;
        };

        const syncWorld = (): void => {
          const seen = new Set<string>();
          for (const item of itemsRef.current) {
            seen.add(item.id);
            let g = groups.get(item.id);
            if (!g) {
              g = buildItem(item);
              groups.set(item.id, g);
              world.add(g);
            }
            g.position.set(item.pose.x, item.pose.y, item.pose.z);
            g.rotation.y = item.pose.rotY;
            g.scale.setScalar(item.pose.scale);
            const active = item.id === selectedRef.current;
            g.traverse((o) => {
              const mesh = o as T3.Mesh;
              const m = mesh.material as T3.MeshStandardMaterial | undefined;
              if (m && 'emissiveIntensity' in m) {
                const meshAny = mesh as unknown as { userData: { baseEmissive?: number } };
                if (meshAny.userData['baseEmissive'] === undefined) {
                  meshAny.userData['baseEmissive'] = m.emissiveIntensity;
                }
                m.emissiveIntensity =
                  active && !m.emissive.getHex()
                    ? 0.25
                    : (meshAny.userData['baseEmissive'] as number);
                if (active && !m.emissive.getHex()) m.emissive.set('#33415e');
                if (!active && m.emissive.getHex() === 0x33415e) {
                  m.emissive.set('#000000');
                }
              }
            });
          }
          for (const [id, g] of Array.from(groups)) {
            if (!seen.has(id)) {
              world.remove(g);
              groups.delete(id);
            }
          }
        };
        syncSceneRef.current = syncWorld;
        syncWorld();

        // Q 版标记：只读 chibi 兜底图做成看板精灵；失败则忽略（2D 回退在面板提示）。
        if (chibi.kind === 'sprite') {
          new THREE.TextureLoader().load(
            chibi.img,
            (tex) => {
              if (disposed) {
                tex.dispose();
                return;
              }
              tex.colorSpace = THREE.SRGBColorSpace;
              const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
              const sprite = new THREE.Sprite(mat);
              sprite.scale.set(1.1, 1.1, 1);
              sprite.position.set(-1.6, 1.15, 1.6);
              sprite.userData['bob'] = true;
              world.add(sprite);
              disposables.push(tex, mat);
            },
            undefined,
            () => {
              /* 贴图失败：3D 照常用，面板提示 2D 回退 */
            },
          );
        }

        // ---- 交互：选中 / 拖家具 / 拖镜头 / 缩放 ----
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUND_Y);
        const activePointers = new Map<number, { x: number; y: number }>();
        let mode: 'idle' | 'orbit' | 'dragItem' | 'pinch' = 'idle';
        let pinchDist = 0;
        let downAt = 0;
        let downX = 0;
        let downY = 0;

        const castAt = (clientX: number, clientY: number): void => {
          const rect = canvas.getBoundingClientRect();
          pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
        };

        const onPointerDown = (e: PointerEvent): void => {
          try {
            canvas.setPointerCapture?.(e.pointerId);
          } catch {
            /* 合成或已释放的指针：跳过捕获，照常处理选中/拖拽 */
          }
          activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          downAt = performance.now();
          downX = e.clientX;
          downY = e.clientY;
          if (activePointers.size === 2) {
            const [a, b] = Array.from(activePointers.values());
            if (a && b) {
              pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
              mode = 'pinch';
            }
            return;
          }
          castAt(e.clientX, e.clientY);
          const hits = raycaster.intersectObjects(world.children, true);
          const hit = hits.find((h) => {
            let o: T3.Object3D | null = h.object;
            while (o) {
              const id = (o.userData as Record<string, unknown>)['furnitureId'];
              if (typeof id === 'string') return true;
              o = o.parent;
            }
            return false;
          });
          if (hit) {
            let o: T3.Object3D | null = hit.object;
            let fid: string | null = null;
            while (o) {
              const id = (o.userData as Record<string, unknown>)['furnitureId'];
              if (typeof id === 'string') {
                fid = id;
                break;
              }
              o = o.parent;
            }
            if (fid) {
              setSelectedId(fid);
              mode = 'dragItem';
              return;
            }
          }
          mode = 'orbit';
        };

        const onPointerMove = (e: PointerEvent): void => {
          const prev = activePointers.get(e.pointerId);
          if (!prev) return;
          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (mode === 'pinch' && activePointers.size === 2) {
            const [a, b] = Array.from(activePointers.values());
            if (a && b) {
              const d = Math.hypot(a.x - b.x, a.y - b.y);
              if (pinchDist > 0 && Number.isFinite(d) && d > 0) {
                orbitRef.current = applyZoom(orbitRef.current, pinchDist / d);
                applyOrbit(orbitRef.current);
              }
              pinchDist = d;
            }
            return;
          }
          if (mode === 'dragItem' && selectedRef.current) {
            castAt(e.clientX, e.clientY);
            const pt = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(groundPlane, pt)) {
              const cur = itemsRef.current.find((i) => i.id === selectedRef.current);
              if (cur) {
                const next = moveItemClamped(cur, pt.x - cur.pose.x, pt.z - cur.pose.z);
                const list = itemsRef.current.map((i) =>
                  i.id === next.id ? next : i,
                );
                itemsRef.current = list;
                try {
                  leaseRef.current?.notifyLocalEdit();
                } catch {
                  /* 探针路径：忽略编辑版本推进失败 */
                }
                setItems(list);
              }
            }
            return;
          }
          if (mode === 'orbit') {
            orbitRef.current = applyDrag(orbitRef.current, dx, dy);
            applyOrbit(orbitRef.current);
          }
        };

        const onPointerUp = (e: PointerEvent): void => {
          activePointers.delete(e.pointerId);
          // 快速点按空地（没命中家具、几乎没移动）→ 取消选中
          if (
            mode === 'orbit' &&
            performance.now() - downAt < 300 &&
            Math.hypot(e.clientX - downX, e.clientY - downY) < 6
          ) {
            setSelectedId(null);
          }
          mode = activePointers.size === 0 ? 'idle' : 'orbit';
        };

        const onWheel = (e: WheelEvent): void => {
          e.preventDefault();
          orbitRef.current = applyZoom(
            orbitRef.current,
            1 + Math.sign(e.deltaY) * 0.12,
          );
          applyOrbit(orbitRef.current);
        };

        on(canvas, 'pointerdown', onPointerDown as EventListener);
        on(canvas, 'pointermove', onPointerMove as EventListener);
        on(canvas, 'pointerup', onPointerUp as EventListener);
        on(canvas, 'pointercancel', onPointerUp as EventListener);
        on(canvas, 'wheel', onWheel as EventListener, { passive: false });

        apiRef.current = {
          setOrbit: (o) => {
            orbitRef.current = o;
            applyOrbit(o);
          },
          moveSelected: (dx, dz) => {
            const cur = itemsRef.current.find((i) => i.id === selectedRef.current);
            if (!cur) return;
            try {
              leaseRef.current?.notifyLocalEdit();
            } catch {
              /* 忽略 */
            }
            const next = moveItemClamped(cur, dx, dz);
            setItems((list) => list.map((i) => (i.id === next.id ? next : i)));
            syncWorld();
          },
        };

        // ---- 尺寸 / 可见性 / reduced-motion ----
        const resize = (): void => {
          const w = mount.clientWidth || 1;
          const h = mount.clientHeight || 1;
          rt.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        resize();
        ro = new ResizeObserver(resize);
        ro.observe(mount);

        let reduceMotion = prefersReducedMotion();
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onMq = (ev: MediaQueryListEvent): void => {
          reduceMotion = ev.matches;
        };
        mq.addEventListener('change', onMq);
        listeners.push([
          mq,
          'change',
          onMq as unknown as EventListener,
          undefined,
        ]);

        let lastFrame = 0;
        let bob = 0;
        const loop = (t: number): void => {
          if (disposed) return;
          raf = requestAnimationFrame(loop);
          if (document.hidden) return;
          if (t - lastFrame < 16) return; // 60fps 上限
          lastFrame = t;
          if (!reduceMotion) {
            bob += 0.03;
            world.traverse((o) => {
              if ((o.userData as Record<string, unknown>)['bob']) {
                o.position.y = 1.15 + Math.sin(bob) * 0.05;
              }
            });
          }
          // preview/测试探针：上报浮动相位与 reduced 开关（生产不传即为 undefined，开销为一次空判断）。
          motionProbeRef.current?.({ bob, reduced: reduceMotion });
          rt.render(scene, camera);
        };
        raf = requestAnimationFrame(loop);
        const onVis = (): void => {
          lastFrame = performance.now();
        };
        on(document, 'visibilitychange', onVis as EventListener);

        syncWorld();
        // 若保存/恢复在场景就绪前已完成并留下 notice，予以保留（完成顺序不丢提示）。
        setStatus((s) => (s.phase === 'ready' && s.notice ? s : { phase: 'ready' }));
        setOrbitLabel(
          `视角 θ${orbitRef.current.theta.toFixed(2)} φ${orbitRef.current.phi.toFixed(2)} r${orbitRef.current.radius.toFixed(1)}`,
        );
      } catch (err) {
        if (disposed) return;
        const reason =
          err instanceof Error ? err.message : 'renderer-init-failed';
        setStatus({ phase: 'fallback', reason });
        onFallback?.(reason);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const [t, type, fn, opts] of listeners) {
        t.removeEventListener(type, fn, opts);
      }
      apiRef.current = null;
      syncSceneRef.current = null;
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* 忽略释放期异常 */
        }
      }
      try {
        renderer?.forceContextLoss?.();
        renderer?.dispose();
      } catch {
        /* 忽略释放期异常 */
      }
      // 只移除本 effect 追加的 canvas；loading spinner 等 React 子节点
      // 由 React 自己管理，绝不能 innerHTML 清空（加载中切换角色会崩溃）。
      appended?.remove();
      appended = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charId, storage, forceFallback, chibiImg]);

  const addFurniture = useCallback(
    (kind: FurnitureKind) => {
      markEdited();
      setItems((list) => {
        // 上界内每个序号都有合法落点：5 列 x 8 行网格全部落在房间 bounds 内
        // （x ∈ ±2.4，z ∈ [2.4, -2.5]），不会制造无法保存的非法布局。
        if (list.length >= ROOM3D_MAX_ITEMS) {
          setStatus({ phase: 'ready', notice: `家具已达上限（${ROOM3D_MAX_ITEMS} 件）` });
          return list;
        }
        const idx = list.length;
        const spot: Room3DFurnitureItem = {
          id: makeFurnitureId(),
          kind,
          pose: spotPoseForIndex(idx),
        };
        return [...list, spot];
      });
    },
    [],
  );

  const rotateSelected = useCallback(() => {
    markEdited();
    setSelectedId((sel) => {
      if (!sel) return sel;
      setItems((list) => list.map((i) => (i.id === sel ? rotateItem(i) : i)));
      return sel;
    });
  }, []);

  const deleteSelected = useCallback(() => {
    markEdited();
    setSelectedId((sel) => {
      if (!sel) return sel;
      setItems((list) => list.filter((i) => i.id !== sel));
      return null;
    });
  }, []);

  const nudgeSelected = useCallback((dx: number, dz: number) => {
    // 单一真相：先同步更新 itemsRef，再 setItems。快速连点/与保存同 tick
    // 批量时也能读到最新位姿；场景同步由每 render 的 syncScene effect 负责，
    // 这里不再经 apiRef.moveSelected 做第二次应用（避免双重位移）。
    const cur = itemsRef.current.find((i) => i.id === selectedRef.current);
    if (!cur) return;
    markEdited();
    const next = moveItemClamped(cur, dx, dz);
    const list = itemsRef.current.map((i) => (i.id === next.id ? next : i));
    itemsRef.current = list;
    setItems(list);
  }, []);

  const resetView = useCallback(() => {
    const o = resetOrbit();
    orbitRef.current = o;
    apiRef.current?.setOrbit(o);
    setOrbitLabel(`视角 θ${o.theta.toFixed(2)} φ${o.phi.toFixed(2)} r${o.radius.toFixed(1)}`);
  }, []);

  const save = useCallback(() => {
    const store = storeRef.current;
    const myCharId = charId;
    const snapshot = itemsRef.current;
    const rev = slotMetaRef.current.rev;
    const lease = leaseRef.current!.beginOperation();
    // 有序元数据确认：同实例/同代次内只有 op 严格递增的 ack 才允许更新
    // slotMeta；旧 ack 不得回退已接纳的 rev。确认成功同步 ref 供下一次
    // save 的 expectedRev 使用；绝不触碰 items/选择/notice/onSaved（迟到路径）。
    const commitSlotMeta = (
      ack: UiOperationLease,
      next: { status: Room3DLoadStatus; rev: string | null; raw: string | null },
    ): boolean => {
      if (!leaseRef.current!.tryAcceptPersistenceAck(ack)) return false;
      slotMetaRef.current = next;
      setSlotMeta(next);
      return true;
    };
    void (async () => {
      const result = await store.save(myCharId, snapshot, {
        expectedRev: rev,
        // 空槽首次保存传 null（仅空槽可写）；之后带上次同步的 rev，防多 tab 覆盖
      });
      if (!mountedRef.current) return; // 卸载：盘已写旧槽，无回调
      if (!leaseRef.current!.isOperationCurrent(lease)) {
        // 迟到：绝不触碰 items/选择/notice/onSaved。
        // 只有有序栅栏接纳的同槽新确认才静默同步 rev/raw，保证下一次保存
        // 的 expectedRev 链不断；跨槽/卸载代次或已被新确认超越的旧 ack 一律丢弃。
        if (result.status === 'saved') {
          commitSlotMeta(lease, { status: 'ok', rev: result.rev, raw: result.rev });
        } else if (result.status === 'conflict' && result.storedRev !== undefined) {
          commitSlotMeta(lease, {
            status: 'ok',
            rev: result.storedRev,
            raw: result.storedRev,
          });
        }
        return;
      }
      if (result.status === 'saved') {
        commitSlotMeta(lease, { status: 'ok', rev: result.rev, raw: result.rev });
        setStatus({ phase: 'ready', notice: '已保存，重新打开可恢复' });
        onSavedRef.current?.(result.state);
      } else if (result.status === 'conflict') {
        // 失败方永不覆盖胜出方：直接载入胜出版本，本地未保存的编辑被放弃（已明确提示）。
        if (result.stored) setItems(result.stored.items);
        commitSlotMeta(lease, {
          status: 'ok',
          rev: result.storedRev ?? null,
          raw: result.storedRev ?? null,
        });
        setSelectedId(null);
        setStatus({
          phase: 'ready',
          notice: '另一处有更新的布置，本次未覆盖，已载入最新版',
        });
      } else if (result.status === 'corrupt-blocked') {
        commitSlotMeta(lease, { status: 'corrupt', rev: null, raw: result.raw });
        setStatus({
          phase: 'ready',
          notice: '存档已损坏，未覆写。请用下方恢复按钮处理',
        });
      } else {
        setStatus({ phase: 'ready', notice: `保存被拒绝：${result.errors[0] ?? ''}` });
      }
    })();
  }, [charId, storage]);

  const recoverCorrupt = useCallback(() => {
    const store = storeRef.current;
    const myCharId = charId;
    const raw = slotMetaRef.current.raw;
    const lease = leaseRef.current!.beginOperation();
    // 恢复路径的元数据同样受有序栅栏控制：旧恢复确认不得覆盖新操作已接纳的 rev。
    const commitSlotMeta = (
      ack: UiOperationLease,
      next: { status: Room3DLoadStatus; rev: string | null; raw: string | null },
    ): boolean => {
      if (!leaseRef.current!.tryAcceptPersistenceAck(ack)) return false;
      slotMetaRef.current = next;
      setSlotMeta(next);
      return true;
    };
    void (async () => {
      const ok = await store.clearCorrupt(myCharId, raw);
      if (!ok) {
        if (!mountedRef.current) return; // 卸载：UI不动
        if (!leaseRef.current!.isOperationCurrent(lease)) return; // 迟到：UI不动（不复活旧错误）
        const meta = store.loadMeta(myCharId);
        commitSlotMeta(lease, { status: meta.status, rev: meta.rev, raw: meta.raw });
        if (meta.state) setItems(meta.state.items);
        setStatus({ phase: 'ready', notice: '恢复失败：存档可能已被其他页面改动，已重新读取' });
        return;
      }
      // 清除已成功：把重建做完（旧槽归属不变），UI 是否更新看迟到判定
      const fresh = createDefaultLayout();
      const result = await store.save(myCharId, fresh, { expectedRev: null });
      if (!mountedRef.current) return; // 卸载：盘已重建，无回调
      if (!leaseRef.current!.isOperationCurrent(lease)) return; // 迟到：盘已重建，UI不动（不清空新进度）
      if (result.status === 'saved') {
        setItems(fresh);
        commitSlotMeta(lease, { status: 'ok', rev: result.rev, raw: result.rev });
        setSelectedId(null);
        setStatus({ phase: 'ready', notice: '已清除损坏数据并重建默认布局' });
      } else {
        const meta = store.loadMeta(myCharId);
        commitSlotMeta(lease, { status: meta.status, rev: meta.rev, raw: meta.raw });
        setStatus({ phase: 'ready', notice: '重建失败，已重新读取当前存档' });
      }
    })();
  }, [charId, storage]);

  if (status.phase === 'fallback') {
    return (
      <div className="flex flex-col gap-3 rounded-3xl bg-white/80 p-5 backdrop-blur-md">
        <p className="text-sm text-slate-700">
          3D 家园暂不可用（{status.reason}），已为你保留 2D 小窝：
        </p>
        {fallback2D ?? (
          <p className="text-sm text-slate-500">
            当前设备不支持 WebGL，2D 小窝不受影响。
          </p>
        )}
      </div>
    );
  }

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={mountRef}
        className="room3d-host relative h-72 w-full overflow-hidden rounded-3xl bg-[#1c2230] sm:h-96"
        aria-label="3D 小家园画布"
      >
        {status.phase === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        )}
      </div>
      {(slotMeta.status === 'corrupt' || slotMeta.status === 'read-error') && (
        <div className="rounded-3xl border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">
            {slotMeta.status === 'corrupt'
              ? '这份家园存档已损坏（原字节已保留，保存不会覆盖它）'
              : '家园存档不可读，保存已暂停以防丢失数据'}
          </p>
          {slotMeta.status === 'corrupt' && (
            <button
              type="button"
              onClick={recoverCorrupt}
              className="mt-2 rounded-xl bg-red-600 px-3 py-1.5 text-xs text-white transition-all duration-200 active:scale-90"
            >
              清除损坏数据并重建默认布局
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-3xl bg-white/80 p-3 backdrop-blur-md">
        {(Object.keys(FURNITURE_CATALOG) as FurnitureKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => addFurniture(kind)}
            className="rounded-xl bg-slate-900/80 px-3 py-1.5 text-xs text-white transition-all duration-200 active:scale-90"
          >
            + {FURNITURE_CATALOG[kind].label}
          </button>
        ))}
        <button
          type="button"
          onClick={resetView}
          className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
        >
          复位视角
        </button>
        <button
          type="button"
          onClick={save}
          className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs text-white shadow-md shadow-emerald-600/30 transition-all duration-200 active:scale-90"
        >
          保存布置
        </button>
      </div>
      {selected && (
        <div className="flex flex-wrap items-center gap-2 rounded-3xl bg-white/80 p-3 backdrop-blur-md">
          <span className="text-xs text-slate-600">
            已选中：{FURNITURE_CATALOG[selected.kind].label}
          </span>
          <button
            type="button"
            onClick={rotateSelected}
            className="rounded-xl border border-slate-300 px-3 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
          >
            旋转 45°
          </button>
          <button
            type="button"
            onClick={() => nudgeSelected(0, -0.2)}
            className="rounded-xl border border-slate-300 px-2 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
            aria-label="上移"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => nudgeSelected(0, 0.2)}
            className="rounded-xl border border-slate-300 px-2 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
            aria-label="下移"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => nudgeSelected(-0.2, 0)}
            className="rounded-xl border border-slate-300 px-2 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
            aria-label="左移"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => nudgeSelected(0.2, 0)}
            className="rounded-xl border border-slate-300 px-2 py-1.5 text-xs text-slate-700 transition-all duration-200 active:scale-90"
            aria-label="右移"
          >
            →
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            className="rounded-xl border border-red-300 px-3 py-1.5 text-xs text-red-600 transition-all duration-200 active:scale-90"
          >
            移出
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>
          {chibi.kind === 'sprite'
            ? `Q 版形象：${chibi.slot} 槽位（只读）`
            : 'Q 版形象：沿用 2D 展示（未读到可用的 chibi 兜底图）'}
        </span>
        {orbitLabel && <span aria-hidden="true">· {orbitLabel}</span>}
        {status.phase === 'ready' && status.notice && <span>· {status.notice}</span>}
        <span aria-hidden="true">· 拖动旋转 · 滚轮/双指缩放 · 点家具拖动</span>
      </div>
    </div>
  );
}

