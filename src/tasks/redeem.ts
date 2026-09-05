import type { CtYunClient } from '../core/client.js';

export interface RewardItem {
  prodId: number;
  prodName: string;
  costPoints: number;
  prodType: string;
  description: string;
}

/**
 * 天翼云积分商城独立兑换任务处理器
 * 支持动态商品目录查询与真实 PaaS/CRM 下单
 */
export class RedeemTask {
  /**
   * 查询官方当前在售积分商品
   */
  public static async getAvailableRewards(client: CtYunClient): Promise<RewardItem[]> {
    const url = `${client.baseUrl}/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS`;
    const rewards: RewardItem[] = [];

    try {
      const res = await fetch(url, { headers: client.getHeaders() });
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

    return rewards;
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
    const url = `${client.baseUrl}/selforder/api/selforder/paas/placeOrder`;
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

    const res = await fetch(url, {
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
