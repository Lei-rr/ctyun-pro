import type { CtYunClient } from '../../core/client.js';
import { safeFetch } from '../../core/utils.js';

export type TaskType = 'chat' | 'hang' | 'login' | 'other';

export function getTaskType(name: string, totalProgress = 0): TaskType {
  const n = name || '';
  if (n.includes('登录')) return 'login';
  if ((n.includes('对话') || n.includes('AI')) && !n.includes('云电脑')) return 'chat';
  const isHangAction = n.includes('使用') || n.includes('体验') || n.includes('时长') || n.includes('挂机');
  if (isHangAction) return 'hang';
  if (totalProgress >= 60 && (n.includes('云电脑') || n.includes('在线'))) {
    return 'hang';
  }
  return 'other';
}

export interface TaskItem {
  type: TaskType;
  name: string;
  desc: string;
  rewardPoints: number;
  currentProgress: number;
  totalProgress: number;
  isCompleted: boolean;
}

export interface PointsSummary {
  generalPoints: number;
  phonePoints: number;
  willExpirePoints: number;
  expireDate?: string;
  tasks: TaskItem[];
}

/**
 * 官方积分与任务进度查询处理器
 */
export class PointsTask {
  /**
   * 查询积分余额与官方任务实时进度
   */
  public static async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    let generalPoints = 0;
    let phonePoints = 0;
    let willExpirePoints = 0;
    let expireDate: string | undefined;

    try {
      const pointRes = await safeFetch(
        'https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints',
        { headers: client.getHeaders() },
      );
      if (pointRes.status === 200) {
        const pointJson = (await pointRes.json()) as { code: number; data?: any[] };
        if (pointJson.code === 0 && Array.isArray(pointJson.data)) {
          const gen =
            pointJson.data.find((p) => !p.willOutDate && p.pointType === 1) ||
            pointJson.data
              .filter((p) => p.pointType === 1)
              .reduce((max, cur) => ((cur.points || 0) > (max.points || 0) ? cur : max), pointJson.data[0]);
          const phone = pointJson.data.find((p) => p.pointType === 500);
          const exp = pointJson.data.find((p) => p.willOutDate);
          if (gen) generalPoints = Number(gen.points || 0);
          if (phone) phonePoints = Number(phone.points || 0);
          if (exp) {
            willExpirePoints = Number(exp.points || 0);
            expireDate = exp.outDateTime;
          }
        }
      }
    } catch {}

    const tasks: TaskItem[] = [];
    try {
      const taskRes = await safeFetch(
        'https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList',
        { headers: client.getHeaders() },
      );
      if (taskRes.status === 200) {
        const taskJson = (await taskRes.json()) as { code: number; data?: any[] };
        if (taskJson.code === 0 && Array.isArray(taskJson.data)) {
          for (const t of taskJson.data) {
            const cur = Number(t.currentProgress || 0);
            const tot = Number(t.totalProgress || 1);
            const reward = Number(t.pointsList?.[0]?.value || 100);
            const taskName = t.taskDefName || '任务';
            const taskType = getTaskType(taskName, tot);
            const isHangTask = taskType === 'hang';
            const isCompleted = isHangTask
              ? (tot > 0 && cur >= Math.max(0, tot - 5)) || t.status === 2 || t.status === '2'
              : (tot > 0 && cur >= tot) || t.status === 2 || t.status === '2';

            tasks.push({
              type: taskType,
              name: taskName,
              desc: t.taskDesc || '',
              rewardPoints: reward,
              currentProgress: cur,
              totalProgress: tot,
              isCompleted,
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
      tasks,
    };
  }
}
