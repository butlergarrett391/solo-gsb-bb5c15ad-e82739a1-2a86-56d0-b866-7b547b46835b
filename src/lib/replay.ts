/**
 * 排练回放核心：纯函数实现，独立于 React。
 *
 * 时间轴直接建立在当前调度结果（computeSchedule 的最早触发 / 最早结束时刻）
 * 之上——资源串行等待与显式依赖均已体现在调度时刻中，回放无需再次处理。
 *
 * 节点三态由「演出时钟 t」唯一确定，因此暂停 / 继续 / 拖动时间轴跳转后，
 * 只需用新的 t 重新计算即可：
 *   t < start         → pending   待触发
 *   start <= t < end  → inProgress 进行中
 *   t >= end          → done      已完成
 * 持续时间为 0 的节点只在 start 瞬时「进行中」，其余时刻按已完成处理。
 */
import type { CueType, ReplayStatus } from '../types';
import type { ScheduleResult } from './schedule';

const EPS = 1e-6;

/** 按演出时钟 t（秒）计算单个提示节点的回放状态 */
export function nodeStatusAt(start: number, end: number, t: number): ReplayStatus {
  if (t + EPS < start) return 'pending';
  if (t + EPS >= end) return 'done';
  return 'inProgress';
}

/** 时间轴上的一个到点（触发）事件 */
export interface CuePoint {
  id: string;
  label: string;
  cueType: CueType;
  /** 排定的最早触发时刻（资源串行 + 显式依赖已计入） */
  start: number;
  /** 排定的最早结束时刻 */
  end: number;
}

interface TimelineNodeLike {
  id: string;
  data: {
    cueType: CueType;
    label?: string;
  };
}

/**
 * 按当前调度结果建立时间轴：每个提示一个到点事件，按触发时刻升序。
 * 同一时刻触发的事件相邻排列，播放时会在同一帧批量到点。
 */
export function cueTimeline<N extends TimelineNodeLike>(
  nodes: N[],
  schedule: ScheduleResult,
): CuePoint[] {
  const points: CuePoint[] = [];
  for (const n of nodes) {
    const s = schedule.byId.get(n.id);
    if (!s) continue;
    points.push({
      id: n.id,
      label: n.data.label ?? n.id,
      cueType: n.data.cueType,
      start: s.earliestStart,
      end: s.earliestEnd,
    });
  }
  points.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  return points;
}

/** 统计各状态节点数量 */
export function countStatuses(
  statusById: Map<string, ReplayStatus>,
): { pending: number; inProgress: number; done: number } {
  const counts = { pending: 0, inProgress: 0, done: 0 };
  for (const s of statusById.values()) counts[s] += 1;
  return counts;
}

/** 时钟格式化：秒 → m:ss.s（如 0:05.0 / 1:02.3） */
export function formatClock(t: number): string {
  const v = Math.max(0, t);
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 回放判断使用的容差，供 UI 层比较时钟与总时长时共用 */
export const REPLAY_EPS = EPS;
