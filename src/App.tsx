import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { CueNode, type CueFlowNode } from './components/CueNode';
import { Inspector } from './components/Inspector';
import { ReplayBar, REPLAY_SPEEDS } from './components/ReplayBar';
import { ResourceBoard } from './components/ResourceBoard';
import { RunTable } from './components/RunTable';
import { Toolbar } from './components/Toolbar';
import { parseShow, serializeShow } from './lib/io';
import {
  combinedGraphHasCycle,
  computeSchedule,
  layeredLayout,
  normalizeResource,
  wouldCreateCycleWithResources,
} from './lib/schedule';
import { cueTimeline, countStatuses, nodeStatusAt, REPLAY_EPS, type CuePoint } from './lib/replay';
import { uid } from './lib/uid';
import { createSampleShow } from './sample';
import { CUE_TYPE_META, type CueNodeData, type CueType, type ReplayStatus } from './types';

const nodeTypes = { cue: CueNode };

const EDGE_STYLE = { stroke: '#5b6b8c', strokeWidth: 1.6 };
const EDGE_STYLE_CRITICAL = { stroke: '#ff5a5a', strokeWidth: 2.6 };
/** 资源串行合成连线：与显式依赖的实线区分，使用金色虚线 */
const RES_EDGE_STYLE = { stroke: '#d8b46a', strokeWidth: 1.6, strokeDasharray: '6 4' };
const RES_EDGE_STYLE_CRITICAL = { stroke: '#ff5a5a', strokeWidth: 2.6, strokeDasharray: '6 4' };

/** 到点提示浮层的停留时长（毫秒） */
const FIRE_ALERT_MS = 3200;

const sample = createSampleShow();

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CueFlowNode>(sample.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(sample.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const rfInstance = useRef<ReactFlowInstance<CueFlowNode, Edge> | null>(null);

  // ---- 排练回放状态 ----
  const [replayMode, setReplayMode] = useState(false);
  const [playing, setPlaying] = useState(false);
  /** 演出时钟（秒）：所有节点状态都由它与调度区间重算得到 */
  const [clock, setClock] = useState(0);
  const [speed, setSpeed] = useState<number>(REPLAY_SPEEDS[1]);
  /** 到点提示浮层（只展示最近一批到点） */
  const [fireAlert, setFireAlert] = useState<{ seq: number; labels: string[] } | null>(null);

  /** 播放基准：真实时间 originMs 对应演出时刻 originClock */
  const originRef = useRef<{ originMs: number; originClock: number } | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const clockRef = useRef(0);
  /** 已经触发过到点提示的节点：跳转 / 暂停继续 / 重置重放均据此去重 */
  const firedRef = useRef<Set<string>>(new Set());
  /** 当前调度结果与时间轴的最新值（供 rAF 回调读取，避免闭包过期） */
  const timelineRef = useRef<CuePoint[]>([]);
  const totalRef = useRef(0);
  const fireSeqRef = useRef(0);
  const fireAlertTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  // 任一节点 / 连线变更后，按依赖 + 资源串行重算最早/最晚时刻与关键路径
  const schedule = useMemo(() => computeSchedule(nodes, edges), [nodes, edges]);

  // 按当前调度结果建立时间轴（资源串行等待与显式依赖已含于调度时刻）
  const timeline = useMemo(() => cueTimeline(nodes, schedule), [nodes, schedule]);

  useEffect(() => {
    timelineRef.current = timeline;
    totalRef.current = schedule.totalDuration;
  }, [timeline, schedule.totalDuration]);

  // ---- 到点提示：仅在时钟被演出时钟连续推进（播放）跨越 start 时触发 ----
  // 拖动时间轴、暂停 / 继续都不会补发；已触发集合保证同一节点不重复提示。
  const fireCuesInRange = useCallback((from: number, to: number) => {
    const due = timelineRef.current.filter(
      (c) => c.start > from - REPLAY_EPS && c.start <= to + REPLAY_EPS && !firedRef.current.has(c.id),
    );
    if (due.length === 0) return;
    for (const c of due) firedRef.current.add(c.id);
    const seq = ++fireSeqRef.current;
    setFireAlert({ seq, labels: due.map((c) => `${CUE_TYPE_META[c.cueType].icon} ${c.label}`) });
    window.clearTimeout(fireAlertTimer.current);
    fireAlertTimer.current = window.setTimeout(() => {
      setFireAlert((cur) => (cur && cur.seq === seq ? null : cur));
    }, FIRE_ALERT_MS);
  }, []);

  // ---- 演出时钟驱动：requestAnimationFrame，到总时长自动暂停 ----
  useEffect(() => {
    if (!playing) {
      playingRef.current = false;
      originRef.current = null;
      return;
    }
    playingRef.current = true;
    speedRef.current = speed;
    originRef.current = { originMs: performance.now(), originClock: clockRef.current };
    let raf = 0;
    const tick = () => {
      if (!playingRef.current || !originRef.current) return;
      const elapsed = ((performance.now() - originRef.current.originMs) / 1000) * speedRef.current;
      const t = originRef.current.originClock + elapsed;
      const total = totalRef.current;
      const prev = clockRef.current;
      if (total > 0 && t >= total) {
        clockRef.current = total;
        setClock(total);
        fireCuesInRange(prev, total);
        setPlaying(false);
        return;
      }
      clockRef.current = t;
      setClock(t);
      fireCuesInRange(prev, t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      playingRef.current = false;
      cancelAnimationFrame(raf);
    };
    // 仅以 playing 为开关；clock / speed 通过 ref 读取，切换倍速时另行重设基准
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => () => window.clearTimeout(fireAlertTimer.current), []);

  // 调度结构变化（编辑节点 / 连线 / 资源 / 导入 / 清空）后，时钟不得越过新总时长
  useEffect(() => {
    if (clockRef.current > schedule.totalDuration + REPLAY_EPS) {
      clockRef.current = schedule.totalDuration;
      setClock(schedule.totalDuration);
      if (schedule.totalDuration === 0) setPlaying(false);
    }
  }, [schedule.totalDuration]);

  // ---- 回放控制 ----
  const resetPlayback = useCallback(() => {
    setPlaying(false);
    clockRef.current = 0;
    setClock(0);
    firedRef.current = new Set();
    setFireAlert(null);
    window.clearTimeout(fireAlertTimer.current);
  }, []);

  const toggleReplay = useCallback(() => {
    // 进入 / 退出回放都从头开始；退出时务必停掉演出时钟
    setPlaying(false);
    clockRef.current = 0;
    setClock(0);
    firedRef.current = new Set();
    setFireAlert(null);
    window.clearTimeout(fireAlertTimer.current);
    setReplayMode((on) => !on);
  }, []);

  const togglePlay = useCallback(() => {
    if (schedule.totalDuration <= 0) return;
    if (playing) {
      setPlaying(false); // 暂停：时钟保留，继续时由当前时钟重算状态
      return;
    }
    // 已走到末尾再按播放：重置触发记录后从头排练
    if (clockRef.current + REPLAY_EPS >= schedule.totalDuration) {
      firedRef.current = new Set();
      setFireAlert(null);
      clockRef.current = 0;
      setClock(0);
    }
    setPlaying(true);
  }, [playing, schedule.totalDuration]);

  /** 拖动时间轴跳转：直接设定时钟，节点状态由新时钟重算；跳转本身不触发提示 */
  const seek = useCallback(
    (t: number) => {
      const clamped = Math.min(Math.max(0, t), schedule.totalDuration);
      clockRef.current = clamped;
      setClock(clamped);
      if (playing) {
        // 播放中拖动：把播放基准移到跳转后的时刻，避免恢复时时钟跳变补发
        originRef.current = { originMs: performance.now(), originClock: clamped };
      }
    },
    [schedule.totalDuration],
  );

  const changeSpeed = useCallback((s: number) => {
    setSpeed(s);
    speedRef.current = s;
    if (playingRef.current) {
      // 以当前时钟为新基准，倍速切换不改变已走到的时刻
      originRef.current = { originMs: performance.now(), originClock: clockRef.current };
    }
  }, []);

  // 当前时钟下每个节点的状态：暂停 / 继续 / 跳转后都经此重算
  const replayStatusById = useMemo(() => {
    const map = new Map<string, ReplayStatus>();
    if (!replayMode) return map;
    for (const c of timeline) map.set(c.id, nodeStatusAt(c.start, c.end, clock));
    return map;
  }, [replayMode, timeline, clock]);

  const replayCounts = useMemo(() => countStatuses(replayStatusById), [replayStatusById]);

  const nextCue = useMemo(
    () => timeline.find((c) => c.start > clock + REPLAY_EPS) ?? null,
    [timeline, clock],
  );

  // 注入计算结果（最早触发时刻、是否关键、回放状态）供节点渲染
  const displayNodes = useMemo<CueFlowNode[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          earliestStart: schedule.byId.get(n.id)?.earliestStart,
          critical: schedule.criticalNodeIds.has(n.id),
          replayStatus: replayMode ? replayStatusById.get(n.id) : undefined,
        },
      })),
    [nodes, schedule, replayMode, replayStatusById],
  );

  const displayEdges = useMemo<Edge[]>(() => {
    const realEdges = edges.map((e) => {
      const critical = schedule.criticalEdgeIds.has(e.id);
      return {
        ...e,
        animated: critical,
        style: critical ? EDGE_STYLE_CRITICAL : EDGE_STYLE,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: critical ? '#ff5a5a' : '#5b6b8c',
        },
      };
    });
    // 资源串行合成连线：仅展示，不可选中 / 删除 / 再次连线
    const resourceEdges: Edge[] = schedule.resourceLinks.map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      sourceHandle: null,
      targetHandle: null,
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      deletable: false,
      animated: link.critical,
      label: `🎚 ${link.resource}`,
      labelStyle: { fill: link.critical ? '#ff8f8f' : '#d8b46a', fontSize: 10, fontWeight: 700 },
      labelBgStyle: { fill: '#1c2434', fillOpacity: 0.85 },
      style: link.critical ? RES_EDGE_STYLE_CRITICAL : RES_EDGE_STYLE,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: link.critical ? '#ff5a5a' : '#d8b46a',
      },
      zIndex: link.critical ? 1 : 0,
    }));
    return [...realEdges, ...resourceEdges];
  }, [edges, schedule]);

  // ---- 连线：阻止成环（依赖 + 资源串行共同构成的约束图） ----
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (wouldCreateCycleWithResources(nodes, edges, conn.source, conn.target)) {
        showToast('无法连接：该连线会与依赖或资源串行顺序形成环路');
        return;
      }
      setEdges((eds) =>
        addEdge({ ...conn, id: uid('e'), markerEnd: { type: MarkerType.ArrowClosed } }, eds),
      );
    },
    [nodes, edges, setEdges, showToast],
  );
  const isValidConnection = useCallback(
    (conn: Edge | Connection) => {
      if (!conn.source || !conn.target) return false;
      return !wouldCreateCycleWithResources(nodes, edges, conn.source, conn.target);
    },
    [nodes, edges],
  );

  // ---- 节点操作 ----
  const addCue = useCallback(
    (type: CueType) => {
      const id = uid('cue');
      const node: CueFlowNode = {
        id,
        type: 'cue',
        position: { x: 120 + (nodes.length % 5) * 36, y: 120 + (nodes.length % 6) * 30 },
        data: {
          label: `${CUE_TYPE_META[type].label}提示 ${nodes.length + 1}`,
          cueType: type,
          duration: 3,
          delay: 0,
          resource: '',
        },
        selected: true,
      };
      setNodes((nds) => [...nds.map((n): CueFlowNode => ({ ...n, selected: false })), node]);
      setSelectedId(id);
    },
    [nodes.length, setNodes],
  );

  const updateCue = useCallback(
    (id: string, patch: Partial<CueNodeData>) => {
      // 资源名修改后，资源串行顺序可能与显式依赖矛盾（成环），拒绝本次修改并恢复原值
      if (patch.resource !== undefined) {
        const candidate = nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, resource: normalizeResource(patch.resource) } } : n,
        );
        if (combinedGraphHasCycle(candidate, edges)) {
          showToast('该资源会与依赖顺序冲突：同资源提示按节点顺序串行，请调整资源或节点顺序');
          const prev = nodes.find((n) => n.id === id)?.data.resource ?? '';
          setNodes((nds) =>
            nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, resource: prev } } : n)),
          );
          return;
        }
        patch = { ...patch, resource: normalizeResource(patch.resource) };
      }
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [nodes, edges, setNodes, showToast],
  );

  const deleteCue = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      firedRef.current.delete(id);
      setSelectedId((sel) => (sel === id ? null : sel));
    },
    [setNodes, setEdges],
  );

  const selectNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })));
      setEdges((eds) => eds.map((e) => ({ ...e, selected: false })));
      setSelectedId(id);
    },
    [setNodes, setEdges],
  );

  const autoLayout = useCallback(() => {
    const pos = layeredLayout(nodes, edges);
    setNodes((nds) => nds.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    window.requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2, duration: 300 }));
  }, [nodes, edges, setNodes]);

  const clearAll = useCallback(() => {
    if (nodes.length === 0) return;
    if (!window.confirm('确定清空全部节点与连线？')) return;
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    resetPlayback();
  }, [nodes.length, setNodes, setEdges, resetPlayback]);

  // 已使用的资源名（去重），供属性面板输入联想
  const resourceOptions = useMemo(
    () => schedule.resources.map((r) => r.name),
    [schedule],
  );

  // ---- JSON 导入 / 导出 ----
  const exportJson = useCallback(() => {
    const text = serializeShow(nodes, edges);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cue-show.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出 JSON 文件');
  }, [nodes, edges, showToast]);

  const importJson = useCallback(
    async (file: File) => {
      const text = await file.text();
      const res = parseShow(text);
      if (!res.ok) {
        showToast(`导入失败：${res.error}`);
        return;
      }
      setNodes(
        res.nodes.map((n) => ({
          id: n.id,
          type: 'cue' as const,
          position: n.position,
          data: {
            label: n.label,
            cueType: n.cueType,
            duration: n.duration,
            delay: n.delay,
            resource: n.resource,
          },
          selected: false,
        })),
      );
      setEdges(
        res.edges.map((e) => ({
          ...e,
          markerEnd: { type: MarkerType.ArrowClosed },
        })),
      );
      setSelectedId(null);
      resetPlayback();
      showToast(`已导入 ${res.nodes.length} 个节点、${res.edges.length} 条连线`);
      window.requestAnimationFrame(() => rfInstance.current?.fitView({ padding: 0.2 }));
    },
    [setNodes, setEdges, showToast, resetPlayback],
  );

  const selectedNode = useMemo(
    () => displayNodes.find((n) => n.id === selectedId) ?? null,
    [displayNodes, selectedId],
  );

  return (
    <div className="app">
      <Toolbar
        totalDuration={schedule.totalDuration}
        criticalCount={schedule.criticalNodeIds.size}
        nodeCount={nodes.length}
        resourceCount={schedule.resources.length}
        onAdd={addCue}
        onAutoLayout={autoLayout}
        onExport={exportJson}
        onImportFile={(f) => void importJson(f)}
        onClear={clearAll}
        replayMode={replayMode}
        onToggleReplay={toggleReplay}
      />
      <div className="main">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length > 0 ? sel[0].id : null)}
            onInit={(inst) => {
              rfInstance.current = inst;
            }}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
            minZoom={0.2}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="#2c3852" />
            <Controls position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) =>
                n.data?.critical ? '#ff5a5a' : { lighting: '#e8a13a', sound: '#3fa9f5', actor: '#c678dd' }[(n as CueFlowNode).data.cueType]
              }
            />
          </ReactFlow>
          {schedule.hasCycle ? (
            <div className="banner-error">
              检测到依赖与资源串行形成环路：调度结果可能不准确，请检查连线或资源节点顺序。
            </div>
          ) : null}
          {replayMode && fireAlert ? (
            <div className="fire-alert" key={fireAlert.seq}>
              <span className="fire-alert-icon">🔔</span>
              <span className="fire-alert-text">
                到点提示：
                {fireAlert.labels.map((l) => (
                  <span className="fire-alert-cue" key={l}>
                    {l}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {replayMode ? (
            <ReplayBar
              playing={playing}
              clock={clock}
              totalDuration={schedule.totalDuration}
              speed={speed}
              nextCue={nextCue}
              counts={replayCounts}
              onTogglePlay={togglePlay}
              onReset={resetPlayback}
              onSeek={seek}
              onSpeedChange={changeSpeed}
            />
          ) : null}
          {toast ? <div className="toast">{toast}</div> : null}
        </div>
        <aside className="sidebar">
          <Inspector
            node={selectedNode}
            schedule={selectedId ? schedule.byId.get(selectedId) ?? null : null}
            resourceOptions={resourceOptions}
            onChange={updateCue}
            onDelete={deleteCue}
          />
          <ResourceBoard schedule={schedule} selectedId={selectedId} onSelect={selectNode} />
          <RunTable
            nodes={displayNodes}
            schedule={schedule}
            selectedId={selectedId}
            onSelect={selectNode}
            replayMode={replayMode}
            replayStatusById={replayStatusById}
          />
        </aside>
      </div>
    </div>
  );
}
