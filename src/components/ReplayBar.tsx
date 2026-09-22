import { CUE_TYPE_META } from '../types';
import type { CuePoint } from '../lib/replay';
import { formatClock } from '../lib/replay';

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

interface ReplayBarProps {
  /** 是否正在播放（false = 已暂停） */
  playing: boolean;
  /** 当前演出时钟（秒） */
  clock: number;
  /** 当前调度总时长（秒），作为时间轴右端 */
  totalDuration: number;
  /** 回放倍速 */
  speed: number;
  /** 下一个到点提示（时钟已越过则为 null） */
  nextCue: CuePoint | null;
  /** 三态节点计数 */
  counts: { pending: number; inProgress: number; done: number };
  onTogglePlay: () => void;
  onReset: () => void;
  onSeek: (t: number) => void;
  onSpeedChange: (speed: number) => void;
}

/** 排练回放控制条：播放 / 暂停、重置、拖动时间轴跳转、倍速与当前时间显示 */
export function ReplayBar(props: ReplayBarProps) {
  const { playing, clock, totalDuration, speed, nextCue, counts } = props;
  const empty = totalDuration <= 0;
  const atEnd = !empty && clock + 1e-6 >= totalDuration;

  return (
    <div className="replay-bar">
      <div className="replay-controls">
        <button
          className="btn replay-play"
          onClick={props.onTogglePlay}
          disabled={empty}
          title={playing ? '暂停（继续后从中断时刻重算状态）' : atEnd ? '重新开始播放' : '播放（演出时钟到点触发提示）'}
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button
          className="btn"
          onClick={props.onReset}
          disabled={empty && clock === 0}
          title="重置回放：时钟归零并清除触发记录"
        >
          ⏮ 重置
        </button>
        <span className="replay-clock" title="当前演出时间">
          {formatClock(clock)}
          <span className="replay-clock-total"> / {formatClock(totalDuration)}</span>
        </span>
        <input
          className="replay-scrubber"
          type="range"
          min={0}
          max={Math.max(totalDuration, 0)}
          step={0.1}
          value={Math.min(clock, Math.max(totalDuration, 0))}
          disabled={empty}
          onChange={(e) => props.onSeek(Number(e.target.value))}
          title="拖动时间轴跳转：节点状态按跳转时刻重算，已完成节点不会重复触发"
        />
        <label className="replay-speed" title="回放倍速">
          <select value={speed} onChange={(e) => props.onSpeedChange(Number(e.target.value))}>
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="replay-info">
        <span className="replay-next">
          {nextCue ? (
            <>
              下一到点{' '}
              <strong>
                {CUE_TYPE_META[nextCue.cueType].icon} {nextCue.label}
              </strong>{' '}
              <span className="num">T+{formatClock(nextCue.start)}</span>
            </>
          ) : empty ? (
            <span className="replay-muted">暂无可回放的提示</span>
          ) : (
            <span className="replay-muted">全部提示已完成，可重置后重新排练</span>
          )}
        </span>
        <span className="replay-counts" title="当前时钟下各状态节点数">
          <span className="rs-pending">🕓 待触发 {counts.pending}</span>
          <span className="rs-progress">🟢 进行中 {counts.inProgress}</span>
          <span className="rs-done">✅ 已完成 {counts.done}</span>
        </span>
      </div>
    </div>
  );
}
