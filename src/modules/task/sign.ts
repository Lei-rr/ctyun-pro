import type { CtYunClient } from '../../core/client.js';
import { safeFetch } from '../../core/utils.js';

export type TaskType = 'sign' | 'hang' | 'login' | 'chat' | 'other';

export function getTaskType(name: string, totalProgress = 0): TaskType {
  const n = name || '';
  if (n.includes('签到') || n.includes('打卡')) return 'sign';
  // 1. 登录类任务 (优先判定，严格与挂机时长任务隔离)
  if (n.includes('登录')) return 'login';

  // 2. AI 对话交互类任务
  if ((n.includes('对话') || n.includes('AI')) && !n.includes('云电脑')) return 'chat';

  // 3. 挂机类任务 (优先名称核心动词，排除登录)
  const isHangAction = n.includes('使用') || n.includes('体验') || n.includes('时长') || n.includes('挂机');
  if (isHangAction) return 'hang';

  // 4. 时长兜底：仅当属于云电脑或在线相关领域且 totalProgress >= 60 时才作为挂机兜底，防误伤其他长周期非挂机任务
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
 * 官方签到与任务进度查询处理器
 */
export class SignTask {
  /**
   * 触发官方真实签到打卡接口 (对齐官方 yz-index 与 marketing/userPoints/receivePointsV2 真实体系)
   */
  public static async signIn(client: CtYunClient): Promise<{ success: boolean; message: string }> {
    // 1. 获取包含打卡任务在内的官方完整任务列表 (带重试)
    let taskJson: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const taskRes = await safeFetch(
          'https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList?displayTypes=2',
          { headers: client.getHeaders() },
        );
        if (taskRes.ok) {
          const json = (await taskRes.json()) as { code: number; msg?: string; data?: any[] };
          if (json.code === 0 && Array.isArray(json.data)) {
            taskJson = json;
            break;
          }
        }
      } catch {}
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }

    if (!taskJson) {
      throw new Error('获取官方任务列表失败（重试3次未成功）');
    }

    // 2. 精准匹配官方连续签到打卡任务 (eventType === 9)
    const checkInTask = taskJson.data?.find((item: any) => item.eventType === 9 || item.eventType === '9');
    if (!checkInTask) {
      return { success: true, message: '当前账号无需或不支持云手机签到，三大每日任务已全部正常就绪' };
    }

    // 若未订购云智手机，官方直接返回 isSatisfiedCondition: false
    if (checkInTask.isSatisfiedCondition === false) {
      return {
        success: true,
        message: '账号未订购云智手机（每日签到仅限云智手机赠送专属积分），已自动跳过；云电脑三大日常任务仍可照常拿满 300 积分',
      };
    }

    const currentProgress = Number(checkInTask.currentProgress || 0);
    // 若当天已签到完成 (官方 canReceive === false)
    if (checkInTask.canReceive === false) {
      return { success: true, message: `今日已完成签到，当前已连续签到 ${currentProgress} 天` };
    }

    // 3. 提交签到打卡推进
    const taskDefId = checkInTask.taskDefId;
    const targetProgress = currentProgress + 1;
    const receiveUrl = `https://desk.ctyun.cn/selforder/api/marketing/userPoints/receivePointsV2?taskDefId=${encodeURIComponent(
      taskDefId,
    )}&progress=${targetProgress}`;

    let recJson: any = null;
    let lastRecErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const recRes = await safeFetch(receiveUrl, { headers: client.getHeaders() });
        if (recRes.ok) {
          recJson = (await recRes.json()) as { code: number; msg?: string; data?: any };
          break;
        } else {
          lastRecErr = `HTTP ${recRes.status}`;
        }
      } catch (e) {
        lastRecErr = e instanceof Error ? e.message : String(e);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }

    if (!recJson) {
      throw new Error(`调用官方签到打卡接口失败: ${lastRecErr || '网络异常'}`);
    }

    if (recJson.code === 0) {
      const reward = checkInTask.pointsList?.[0]?.value || 10;
      return {
        success: true,
        message: `签到打卡成功！已连续签到 ${targetProgress} 天 (+${reward}积分)`,
      };
    }

    if (
      recJson.msg &&
      (recJson.msg.includes('已经签到') || recJson.msg.includes('已完成') || recJson.msg.includes('已领取'))
    ) {
      return { success: true, message: `今日已完成签到，当前已连续签到 ${currentProgress} 天` };
    }

    throw new Error(recJson.msg || '签到接口调用未通过');
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
      const pointRes = await safeFetch(
        'https://desk.ctyun.cn/selforder/api/marketing/userPoints/getUserPoints',
        { headers: client.getHeaders() },
      );
      if (pointRes.status === 200) {
        const pointJson = (await pointRes.json()) as { code: number; data?: any[] };
        if (pointJson.code === 0 && Array.isArray(pointJson.data)) {
          // 官方数据中可能包含两项：一项是 willOutDate: true 即将过期的子积分（如100分），一项为真实总积分（如900分）
          // 优先精准提取非即将过期（!p.willOutDate && p.pointType === 1）的主账户可用总积分项；若都无标识则取数值最大项！
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
            // 仅对挂机类任务给予 5 秒冗余容错
            // 普通计数类任务 (如「与AI对话1次」「登录AI云电脑」tot=1) 必须严格满足 cur >= tot 或官方 status === 2
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
