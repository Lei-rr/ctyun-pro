import type { CtYunClient } from '../core/client.js';
import { safeFetch } from '../core/utils.js';

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
 * 天翼云积分商城独立兑换任务处理器
 * 支持动态商品目录查询与真实 PaaS/CRM 下单
 */
export class RedeemTask {
  private static readonly DESK_URL = 'https://desk.ctyun.cn';

  /**
   * 查询官方当前在售积分商品
   */
  public static async getAvailableRewards(client: CtYunClient): Promise<RewardItem[]> {
    const url = `${RedeemTask.DESK_URL}/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS`;
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
                  description: String(sku.description || series.description || '').replace(/<[^>]+>/g, '').trim(),
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
   * 提交兑换订单
   */
  public static async placeOrder(
    client: CtYunClient,
    desktopId: string | number,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!prodId || !costPoints || !prodType) throw new Error('未提供官方商品信息，无法兑换');
    const url = `${RedeemTask.DESK_URL}/selforder/api/selforder/paas/placeOrder`;
    const payload = {
      busiChannel: '010',
      orderType: 1,
      pointType: 1,
      points: Number(costPoints),
      sku: [
        {
          execSort: 1,
          prodId: Number(prodId),
          prodType,
          attrs: [{ attrKey: 'bindDesktopId', attrVal: Number(desktopId) }],
        },
      ],
    };

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        ...client.getHeaders(),
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify(payload),
    });

    const json = (await res.json()) as { code: number; msg?: string };
    if (json.code === 0) {
      return { success: true, message: `兑换成功！消耗 ${costPoints} 积分` };
    }
    throw new Error(json.msg || `兑换失败 (Code: ${json.code})`);
  }
}
