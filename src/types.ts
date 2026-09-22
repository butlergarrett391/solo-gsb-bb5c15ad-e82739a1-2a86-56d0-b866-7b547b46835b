/** 提示（Cue）类型：灯光 / 音效 / 演员 */
export type CueType = 'lighting' | 'sound' | 'actor';

/** 画布节点携带的业务数据 */
export type CueNodeData = {
  /** 显示名称 */
  label: string;
  /** 提示类型 */
  cueType: CueType;
  /** 持续时间（秒） */
  duration: number;
  /**
   * 相对延迟（秒）：
   * 所有前置（含依赖与资源排队）约束结束后，再等待该时长才触发；
   * 无前置约束时，表示相对演出开始（T+0）的延迟。
   */
  delay: number;
  /**
   * 占用的舞台资源名（如「追光1」「麦克风A」）；
   * 空串表示不占用资源。同一资源上的提示按节点顺序串行、互不重叠。
   */
  resource: string;
  /** 由调度器计算后注入：最早触发时刻（秒），仅用于展示 */
  earliestStart?: number;
  /** 由调度器计算后注入：是否位于关键路径上 */
  critical?: boolean;
};

export const CUE_TYPES: CueType[] = ['lighting', 'sound', 'actor'];

export const CUE_TYPE_META: Record<CueType, { icon: string; label: string }> = {
  lighting: { icon: '💡', label: '灯光' },
  sound: { icon: '🔊', label: '音效' },
  actor: { icon: '🎭', label: '演员' },
};
