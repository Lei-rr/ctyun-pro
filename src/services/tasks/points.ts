import type { CtYunClient } from '../../ctyun/client.js';
import { safeFetch } from '../../infra/http.js';

export type TaskType = 'chat' | 'hang' | 'login' | 'other';

/**
 * 官方积分任务状态 (对齐 desk.ctyun.cn/selforder/points 前端 TASK_STATUS)
 * 0 未完成 / 1 待领取 / 2 已领取 / 3 已失效
 */
export const TASK_STATUS = {
  TODO: 0,
  UNCLAIMED: 1,
  DONE: 2,
  EXPR: 3,
} as const;

/**
 * 官方积分任务定义 ID (对齐官方 TASK_MAP)
 * 1002 每日登录 / 1001 每月登录 / 1003 每日使用1小时 / 1004 每日AI对话
 * 1101 绑定手机号 / 1102 AI对话 / 1103 登录 / 1104 连续登录 / 1105 使用1小时 / 1106 累计使用20小时
 */
export const TASK_DEF = {
  LOGIN_DAY: 1002,
  LOGIN_MONTH: 1001,
  USE_HOUR_DAY: 1003,
  AI_CHAT: 1004,
  BIND_PHONE: 1101,
  AI_CHAT_ALT: 1102,
  LOGIN_DAY_ALT: 1103,
  LOGIN_CONTINUOUS: 1104,
  USE_HOUR_DAY_ALT: 1105,
  USE_HOUR_TOTAL: 1106,
} as const;

/**
 * 官方积分类型 (对齐官方 PONIT_TYPE)
 * 1 通用 / 10 专属 / 20 九江专属
 */
export const POINT_TYPE = {
  GENERAL: 1,
  EXCLUSIVE: 10,
  JIUJIANG: 20,
} as const;

/** 官方任务周期 (对齐 TASK_CALENDAR_TYPE) */
export const TASK_CALENDAR_TYPE = {
  DAY: 5,
  WEEK: 3,
  MONTH: 2,
  YEAR: 1,
  PERMANENT: 0,
} as const;

export const TASK_STATUS_TEXT: Record<number, string> = {
  [TASK_STATUS.TODO]: '未完成',
  [TASK_STATUS.UNCLAIMED]: '待领取',
  [TASK_STATUS.DONE]: '已领取',
  [TASK_STATUS.EXPR]: '已失效',
};

export interface TaskPointItem {
  type: number;
  typeDesc: string;
  value: number;
}

export interface TaskItem {
  taskDefId: number;
  type: TaskType;
  name: string;
  desc: string;
  calendarType: number;
  status: number;
  statusText: string;
  isCompleted: boolean;
  canClaim: boolean;
  rewardPoints: number;
  points: TaskPointItem[];
  pointsList: TaskPointItem[];
  currentProgress: number;
  totalProgress: number;
}

export interface PointsSummary {
  generalPoints: number;
  phonePoints: number;
  willExpirePoints: number;
  expireDate?: string;
  expireDetail: Array<{ pointType: number; pointTypeName?: string; points: number; outDateTime?: string }>;
  pointList: Array<{ pointType: number; pointTypeName?: string; points: number; totalPoints: number; exchangeUrl?: string }>;
  tasks: TaskItem[];
}

export function getTaskTypeByDefId(taskDefId: number, name = ''): TaskType {
  if (taskDefId === TASK_DEF.AI_CHAT || taskDefId === TASK_DEF.AI_CHAT_ALT) return 'chat';
  if (
    taskDefId === TASK_DEF.USE_HOUR_DAY ||
    taskDefId === TASK_DEF.USE_HOUR_DAY_ALT ||
    taskDefId === TASK_DEF.USE_HOUR_TOTAL
  ) {
    return 'hang';
  }
  if (
    taskDefId === TASK_DEF.LOGIN_DAY ||
    taskDefId === TASK_DEF.LOGIN_MONTH ||
    taskDefId === TASK_DEF.LOGIN_DAY_ALT ||
    taskDefId === TASK_DEF.LOGIN_CONTINUOUS
  ) {
    return 'login';
  }
  const n = name || '';
  if (n.includes('登录')) return 'login';
  if ((n.includes('对话') || n.includes('AI')) && !n.includes('云电脑')) return 'chat';
  if (n.includes('使用') || n.includes('体验') || n.includes('时长') || n.includes('挂机')) return 'hang';
  return 'other';
}

/**
 * 是否为每日任务 (用于「今日已获积分」统计)
 */
export function isDailyTask(task: Pick<TaskItem, 'calendarType' | 'taskDefId'>): boolean {
  if (task.calendarType === TASK_CALENDAR_TYPE.DAY) return true;
  if (task.calendarType > 0) return false;
  // 兜底：按官方任务定义判定每日任务
  return [
    TASK_DEF.LOGIN_DAY,
    TASK_DEF.USE_HOUR_DAY,
    TASK_DEF.AI_CHAT,
    TASK_DEF.AI_CHAT_ALT,
    TASK_DEF.LOGIN_DAY_ALT,
    TASK_DEF.USE_HOUR_DAY_ALT,
  ].includes(task.taskDefId as never);
}

export interface PointDetailItem {
  msgType: number;
  pointsList: Array<{ type: number; typeDesc: string; value: number }>;
  createTime?: string;
  remark?: string;
  [key: string]: unknown;
}

/**
 * 官方积分与任务进度查询处理器
 * 严格对齐 desk.ctyun.cn/selforder/points 官方积分中心数据模型
 */
export class PointsTask {
  private static readonly SELFORDER_URL = 'https://desk.ctyun.cn/selforder';

  private static parseRewardPoints(pointsList: any[] | undefined): { points: TaskPointItem[]; rewardPoints: number } {
    const points: TaskPointItem[] = [];
    let rewardPoints = 0;
    if (Array.isArray(pointsList)) {
      for (const p of pointsList) {
        const value = Number(p?.value ?? 0);
        points.push({
          type: Number(p?.type ?? POINT_TYPE.GENERAL),
          typeDesc: String(p?.typeDesc ?? '积分'),
          value,
        });
        rewardPoints += value;
      }
    }
    return { points, rewardPoints };
  }

  /**
   * 查询积分余额与官方任务实时进度 (对齐官方 getUserPoints / getTaskList)
   */
  public static async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    let generalPoints = 0;
    let phonePoints = 0;
    let willExpirePoints = 0;
    let expireDate: string | undefined;
    const expireDetail: PointsSummary['expireDetail'] = [];
    const pointList: PointsSummary['pointList'] = [];

    try {
      const pointRes = await safeFetch(
        `${this.SELFORDER_URL}/api/marketing/userPoints/getUserPoints`,
        { headers: client.getHeaders() },
      );
      if (pointRes.status === 200) {
        const pointJson = (await pointRes.json()) as { code: number; data?: any[] };
        if (pointJson.code === 0 && Array.isArray(pointJson.data)) {
          const valid = pointJson.data.filter((p) => !p.willOutDate);
          // 按积分类型聚合 totalPoints (对齐官方 pointsList computed)
          const pointMap = new Map<number, { pointType: number; pointTypeName?: string; points: number; totalPoints: number; exchangeUrl?: string }>();
          for (const p of valid) {
            const type = Number(p.pointType ?? POINT_TYPE.GENERAL);
            const value = Number(p.points ?? 0);
            const exist = pointMap.get(type);
            if (exist) {
              exist.totalPoints += value;
            } else {
              pointMap.set(type, {
                pointType: type,
                pointTypeName: p.pointTypeName,
                points: value,
                totalPoints: value,
                exchangeUrl: p.exchangeUrl,
              });
            }
          }
          pointList.push(...pointMap.values());

          const gen = pointMap.get(POINT_TYPE.GENERAL);
          const phone = pointMap.get(500);
          if (gen) generalPoints = gen.totalPoints;
          if (phone) phonePoints = phone.totalPoints;

          for (const p of pointJson.data) {
            if (p.willOutDate) {
              willExpirePoints += Number(p.points || 0);
              if (!expireDate || (p.outDateTime && p.outDateTime < expireDate)) {
                expireDate = p.outDateTime || expireDate;
              }
              expireDetail.push({
                pointType: Number(p.pointType ?? 0),
                pointTypeName: p.pointTypeName,
                points: Number(p.points || 0),
                outDateTime: p.outDateTime,
              });
            }
          }
        }
      }
    } catch {}

    const tasks: TaskItem[] = [];
    try {
      const taskRes = await safeFetch(
        `${this.SELFORDER_URL}/api/marketing/userPoints/getTaskList`,
        { headers: client.getHeaders() },
      );
      if (taskRes.status === 200) {
        const taskJson = (await taskRes.json()) as { code: number; data?: any[] };
        if (taskJson.code === 0 && Array.isArray(taskJson.data)) {
          for (const t of taskJson.data) {
            const taskDefId = Number(t.taskDefId || 0);
            const taskName = t.taskDefName || t.taskDesc || '任务';
            const status = Number(t.status ?? TASK_STATUS.TODO);
            const { points, rewardPoints } = this.parseRewardPoints(t.pointsList);
            const taskType = getTaskTypeByDefId(taskDefId, taskName);
            const currentProgress = Number(t.currentProgress || 0);
            const isCompleted = status === TASK_STATUS.DONE;
            const canClaim = status === TASK_STATUS.UNCLAIMED;

            tasks.push({
              taskDefId,
              type: taskType,
              name: taskName,
              desc: t.taskDesc || '',
              calendarType: Number(t.taskCalendarType ?? -1),
              status,
              statusText: TASK_STATUS_TEXT[status] || '未知',
              isCompleted,
              canClaim,
              rewardPoints,
              points,
              pointsList: points,
              currentProgress,
              totalProgress: Number(t.totalProgress ?? 0),
            });
          }
        }
      }
    } catch {}

    return {
      generalPoints,
      phonePoints,
      willExpirePoints,
      expireDate,
      expireDetail,
      pointList,
      tasks,
    };
  }

  /**
   * 查询积分收支明细 (对齐官方 getPointDetailList)
   */
  public static async getPointDetailList(
    client: CtYunClient,
    options: { pageNum?: number; pageSize?: number; msgType?: number } = {},
  ): Promise<{ list: PointDetailItem[]; total: number; pageNum: number; pageSize: number; hasMore: boolean }> {
    const pageNum = Math.max(1, Number(options.pageNum || 1));
    const pageSize = Math.max(1, Math.min(50, Number(options.pageSize || 10)));

    const params = new URLSearchParams();
    params.append('pageNum', String(pageNum));
    params.append('pageSize', String(pageSize));
    if (options.msgType !== undefined && options.msgType !== null) {
      params.append('msgType', String(options.msgType));
    }

    const res = await safeFetch(
      `${this.SELFORDER_URL}/api/marketing/userPoints/getPointDetailList?${params.toString()}`,
      { headers: client.getHeaders() },
    );
    if (res.status !== 200) {
      throw new Error(`查询积分明细失败 (HTTP ${res.status})`);
    }
    const json = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { list?: PointDetailItem[]; total?: number; isLastPage?: boolean } | PointDetailItem[];
    };
    if (json.code !== 0) {
      throw new Error(json.msg || `查询积分明细失败 (Code ${json.code})`);
    }

    const rawList = Array.isArray(json.data) ? json.data : (json.data?.list || []);
    const total = Array.isArray(json.data) ? rawList.length : Number(json.data?.total ?? rawList.length);
    const isLastPage = !Array.isArray(json.data) && json.data?.isLastPage !== undefined
      ? Boolean(json.data.isLastPage)
      : undefined;
    const list = rawList.map((item) => ({
      ...item,
      msgType: Number(item.msgType ?? 0),
      pointsList: Array.isArray(item.pointsList)
        ? item.pointsList.map((p) => ({
            type: Number(p?.type ?? POINT_TYPE.GENERAL),
            typeDesc: String(p?.typeDesc ?? '积分'),
            value: Number(p?.value ?? 0),
          }))
        : [],
    }));

    return {
      list,
      total,
      pageNum,
      pageSize,
      // 优先使用官方 isLastPage 精确判定，缺失时按分页总数兜底
      hasMore: isLastPage !== undefined ? !isLastPage : pageNum * pageSize < total,
    };
  }
}
