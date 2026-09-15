import type { CtYunClient } from '../../core/client.js';
import { safeFetch } from '../../core/utils.js';
import { SignTask } from '../task/sign.js';

export interface RewardItem {
  prodId: number;
  prodName: string;
  costPoints: number;
  prodType: string;
  description: string;
}

/**
 * 官方积分商城全量本地化商品目录（离线与降级兜底预设）
 */
export const DEFAULT_LOCAL_REWARDS: RewardItem[] = [
  {
    prodId: 17023101,
    prodName: '8C16G升配包1天',
    costPoints: 500,
    prodType: 'pointstplupgrade',
    description: '可将AI云电脑（公众版、政企版）升配至8C16G，最多支持兑换365天；规格升配、重置均会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17023111,
    prodName: '16C32G升配包1天',
    costPoints: 1000,
    prodType: 'pointstplupgrade',
    description: '可将AI云电脑（政企版）升配至16C32G，最多支持兑换365天；规格升配、恢复均会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17021101,
    prodName: '天翼AI云手机1个月试用',
    costPoints: 9000,
    prodType: 'pointscomputer',
    description: '权益：天翼AI云手机包月不限时，有效期1个月',
  },
  {
    prodId: 17022101,
    prodName: '游戏AI云电脑包月5小时试用',
    costPoints: 7500,
    prodType: 'pointscomputer',
    description: '权益：游戏AI云电脑包月5小时试用，有效期1个月',
  },
  {
    prodId: 17010101,
    prodName: '专属智库1G存储空间',
    costPoints: 1000,
    prodType: 'cpcai',
    description: '权益：基于当前AI应用中心存储空间，叠加1G存储空间，每月限兑5次',
  },
  {
    prodId: 17020101,
    prodName: 'AI应用中心高级版',
    costPoints: 1000,
    prodType: 'cpcai',
    description: '权益：AI应用中心高级版，支持DeepSeek满血版、专属智库等，有效期1个月',
  },
  {
    prodId: 17024101,
    prodName: '1G数据盘永久扩容',
    costPoints: 1200,
    prodType: 'pointsdiskupgrade',
    description: '兑换后，将自动创建1个新数据盘，该盘仅支持积分扩容，最大不超过500GB',
  },
];

/**
 * 商品稳定规范排序：常用升配包（8C16G、16C32G）置顶，其余商品按积分梯级固定排序
 */
export function sortRewards(items: RewardItem[]): RewardItem[] {
  const priorityOrder = [
    17023101, // 8C16G升配包1天
    17023111, // 16C32G升配包1天
    17021101, // 天翼AI云手机1个月试用
    17022101, // 游戏AI云电脑包月5小时试用
    17010101, // 专属智库1G存储空间
    17020101, // AI应用中心高级版
    17024101, // 1G数据盘永久扩容
  ];
  return [...items].sort((a, b) => {
    const idxA = priorityOrder.indexOf(a.prodId);
    const idxB = priorityOrder.indexOf(b.prodId);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.costPoints - b.costPoints;
  });
}

/**
 * 积分商城与自动兑换业务服务 (Reward & Redeem Service)
 *
 * 铁律规范：
 * 1. 严格本地强比对：积分不足直接本地拦截阻断，严禁向官方下单接口发送无效请求；
 * 2. 硬件绑定强校验：升配包与扩容盘必须校验绑定的有效 desktopId；
 * 3. 兑换全流程审计闭环并记录日志。
 */
export class RewardRedeemService {
  private static readonly DESK_URL = 'https://desk.ctyun.cn';

  /**
   * 查询官方在线在售积分商品
   */
  public static async getAvailableRewards(client: CtYunClient): Promise<RewardItem[]> {
    const url = `${RewardRedeemService.DESK_URL}/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS`;
    const rewards: RewardItem[] = [];

    try {
      const res = await safeFetch(url, { headers: client.getHeaders() });
      if (res.status === 200) {
        const json = (await res.json()) as { code: number; data?: any[] };
        if (json.code === 0 && Array.isArray(json.data)) {
          for (const mall of json.data) {
            for (const series of mall.series || []) {
              for (const sku of series.sku || []) {
                rewards.push({
                  prodId: Number(sku.prodId),
                  prodName: String(sku.prodName || '').trim(),
                  costPoints: Number(sku.costPoints || 0),
                  prodType: String(sku.prodType || 'pointstplupgrade').trim(),
                  description: String(sku.description || series.description || '')
                    .replace(/<[^>]+>/g, '')
                    .trim(),
                });
              }
            }
          }
        }
      }
    } catch {}

    return sortRewards(rewards);
  }

  /**
   * 反查商品规格信息（在线优先，本地预设兜底）
   */
  public static async resolveReward(client?: CtYunClient, prodId?: number): Promise<RewardItem | undefined> {
    if (!prodId) return undefined;
    const numId = Number(prodId);
    if (client) {
      try {
        const list = await RewardRedeemService.getAvailableRewards(client);
        const match = list.find((i) => Number(i.prodId) === numId);
        if (match) return match;
      } catch {}
    }
    return DEFAULT_LOCAL_REWARDS.find((i) => Number(i.prodId) === numId);
  }

  /**
   * 提交兑换订单（含严格本地双重风控拦截）
   */
  public static async placeOrder(
    client: CtYunClient,
    desktopId?: string | number,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!prodId) throw new Error('未提供目标商品 ID，无法发起兑换');

    let resolvedPoints = costPoints ? Number(costPoints) : 0;
    let resolvedType = prodType ? String(prodType).trim() : '';

    if (!resolvedPoints || !resolvedType) {
      const item = await RewardRedeemService.resolveReward(client, Number(prodId));
      if (item) {
        resolvedPoints = resolvedPoints || item.costPoints;
        resolvedType = resolvedType || item.prodType;
      }
    }

    if (!resolvedPoints || !resolvedType) {
      throw new Error(`未获取到商品 [${prodId}] 的规格参数(costPoints/prodType)，无法兑换`);
    }

    // 1. 积分硬性前置强校验：查询账号真实可用积分
    try {
      const pointSummary = await SignTask.getPointsAndTasks(client);
      const currentPoints = Number(pointSummary.generalPoints || 0);
      if (currentPoints < resolvedPoints) {
        throw new Error(
          `[积分不足拦截] 当前可用积分 ${currentPoints} 不足，兑换商品需要 ${resolvedPoints} 积分，已放弃下单`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('[积分不足拦截]')) {
        throw err;
      }
    }

    // 2. 硬件绑定类商品校验（如升配包 pointstplupgrade、数据盘 pointsdiskupgrade）
    const isHardwareBound = resolvedType === 'pointstplupgrade' || resolvedType === 'pointsdiskupgrade';
    const attrs: any[] = [];
    let finalDesktopId = desktopId;
    let numDesktopId = Number(finalDesktopId);
    let isValidDesktopId = Boolean(
      finalDesktopId &&
        finalDesktopId !== 'undefined' &&
        finalDesktopId !== 'null' &&
        Number.isFinite(numDesktopId) &&
        numDesktopId > 0,
    );

    if (!isValidDesktopId) {
      // 容错反查兜底：若传入的是 desktopCode 或未指定桌面，自动拉取账号桌面列表进行匹配或取首台兜底
      try {
        const list = await client.getDesktopList();
        const found = finalDesktopId
          ? list.find(
              (d: any) =>
                d.desktopCode === finalDesktopId || String(d.desktopId) === String(finalDesktopId),
            )
          : list[0];
        if (found?.desktopId && Number.isFinite(Number(found.desktopId))) {
          finalDesktopId = found.desktopId;
          numDesktopId = Number(finalDesktopId);
          isValidDesktopId = true;
        }
      } catch {}
    }

    if (isHardwareBound) {
      if (!isValidDesktopId) {
        throw new Error(
          `[参数错误拦截] 商品类型 [${resolvedType}] 为硬件绑定资源，必须绑定有效云电脑桌面 ID，防止官方返回“目标资源不存在”`,
        );
      }
      attrs.push({ attrKey: 'bindDesktopId', attrVal: numDesktopId });
    } else if (isValidDesktopId) {
      attrs.push({ attrKey: 'bindDesktopId', attrVal: numDesktopId });
    }

    const url = `${RewardRedeemService.DESK_URL}/selforder/api/selforder/paas/placeOrder`;
    const payload = {
      busiChannel: '010',
      orderType: 1,
      pointType: 1,
      points: Number(resolvedPoints),
      sku: [
        {
          execSort: 1,
          prodId: Number(prodId),
          prodType: resolvedType,
          attrs,
        },
      ],
    };

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        ...client.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.status !== 200) {
      throw new Error(`下单接口 HTTP 响应异常: ${res.status}`);
    }

    const resJson = (await res.json()) as { code: number; message?: string; msg?: string; data?: any };
    if (resJson.code !== 0) {
      const errDetail = resJson.message || resJson.msg || '未知错误';
      throw new Error(`官方兑换失败: ${errDetail}`);
    }

    return {
      success: true,
      message: `兑换成功！订单号: ${resJson.data?.orderId || '已生成'}，消耗 ${resolvedPoints} 积分`,
    };
  }
}
