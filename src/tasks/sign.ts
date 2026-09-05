import type { CtYunClient } from '../core/client.js';

export interface TaskItem {
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
 * 官方签到与任务进度查询处理器
 */
export class SignTask {
  /**
   * 触发官方签到打卡接口
   */
  public static async signIn(client: CtYunClient): Promise<{ success: boolean; message: string }> {
    const endpoints = [
      'https://desk.ctyun.cn/selforder/api/marketing/userPoints/signIn',
      'https://desk.ctyun.cn/selforder/api/marketing/userPoints/dailyCheckIn',
      'https://desk.ctyun.cn/selforder/api/marketing/userPoints/punchCard',
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...client.getHeaders(),
            'Content-Type': 'application/json;charset=UTF-8',
          },
          body: JSON.stringify({}),
        });

        if (res.ok) {
          const data = (await res.json()) as { code: number; msg?: string };
          if (data.code === 0) {
            return { success: true, message: data.msg || '签到成功，已获取积分！' };
          }
          if (
            (data.msg && (data.msg.includes('已经签到') || data.msg.includes('已打卡'))) ||
            data.code === 40001
          ) {
            return { success: true, message: '今日已完成签到，无需重复打卡' };
          }
        }
      } catch {}
    }
    return { success: false, message: '签到接口未确认成功，请稍后查看任务状态' };
  }

  /**
   * 查询积分余额与官方任务实时进度
   */
  public static async getPointsAndTasks(client: CtYunClient): Promise<PointsSummary> {
    let generalPoints = 0;
    let phonePoints = 0;
    let willExpirePoints = 0;
    let expireDate: string | undefined;

    try {
      const pointRes = await fetch(
        'https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints',
        { headers: client.getHeaders() },
      );
      if (pointRes.status === 200) {
        const pointJson = (await pointRes.json()) as { code: number; data?: any[] };
        if (pointJson.code === 0 && Array.isArray(pointJson.data)) {
          const gen = pointJson.data.find((p) => p.pointType === 1);
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
      const taskRes = await fetch(
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
            tasks.push({
              name: t.taskDefName || '任务',
              desc: t.taskDesc || '',
              rewardPoints: reward,
              currentProgress: cur,
              totalProgress: tot,
              isCompleted: cur >= tot && tot > 0,
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
