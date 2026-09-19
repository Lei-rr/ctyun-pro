import type { CtYunClient, OrderStatisticsQuery } from '../../ctyun/client.js';
import { safeFetch , errorText } from '../../infra/http.js';
import { PointsTask, POINT_TYPE } from '../tasks/points.js';

export interface RewardItem {
  prodId: number;
  prodName: string;
  costPoints: number;
  prodType: string;
  costPointType: number; // 官方 PONIT_TYPE: 1 通用 / 10 专属 / 20 九江专属
  description: string;
  prodStatus?: number; // 官方 2 = 在售
  effDate?: string;
  expireDate?: string;
  orderCount?: number; // 本周期已兑换次数
  userLimitCount?: number; // 本周期兑换上限 (-1 不限)
  totalCount?: number; // 已兑换总量
  totalLimitSize?: number; // 库存总量 (-1 不限)
  /** 是否需要绑定云电脑硬件 (bindDesktopId) */
  hardwareBound?: boolean;
  /** 是否需要绑定手机号 (mobilephone) */
  phoneBound?: boolean;
  /** 官方原始 attrs (供兑换统计 / 限购周期查询使用) */
  rawAttrs?: Array<{ attrKey: string; attrVal: unknown }>;
}

/** 官方需要绑定云电脑硬件的商品 ID */
export const HARDWARE_BOUND_PROD_IDS = [
  17023101, // 8C16G升配包1天
  17023111, // 16C32G升配包1天
  17024101, // 1G数据盘永久扩容
  17026101, // XC云电脑8C16G升配包
  17026111, // XC云电脑16C32G升配包
];

/** 官方需要绑定手机号的商品 ID */
export const PHONE_BOUND_PROD_IDS = [
  17022101, // 游戏AI云电脑包月试用
  17021101, // 天翼AI云手机试用
];

/** 官方实名认证通过状态码 (对齐 REAL_NAME_STATUS.VERIFY_SUCCESS) */
export const REAL_NAME_VERIFIED = 3;

/**
 * 官方积分商城全量本地化商品目录（离线与降级兜底预设）
 * 字段与官方 PROD_ID / prod/get 返回保持一致
 */
export const DEFAULT_LOCAL_REWARDS: RewardItem[] = [
  {
    prodId: 17023101,
    prodName: '8C16G升配包1天',
    costPoints: 500,
    prodType: 'pointstplupgrade',
    costPointType: POINT_TYPE.GENERAL,
    hardwareBound: true,
    description: '可将AI云电脑（公众版、政企版）升配至8C16G，最多支持兑换365天；规格升配、重置均会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17023111,
    prodName: '16C32G升配包1天',
    costPoints: 1000,
    prodType: 'pointstplupgrade',
    costPointType: POINT_TYPE.GENERAL,
    hardwareBound: true,
    description: '可将AI云电脑（政企版）升配至16C32G，最多支持兑换365天；规格升配、恢复均会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17026101,
    prodName: 'XC云电脑8C16G升配包',
    costPoints: 500,
    prodType: 'pointstplupgrade',
    costPointType: POINT_TYPE.EXCLUSIVE,
    hardwareBound: true,
    description: 'XC云电脑规格升配包，规格升配会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17026111,
    prodName: 'XC云电脑16C32G升配包',
    costPoints: 1000,
    prodType: 'pointstplupgrade',
    costPointType: POINT_TYPE.EXCLUSIVE,
    hardwareBound: true,
    description: 'XC云电脑规格升配包，规格升配会重启AI云电脑，请注意保存数据',
  },
  {
    prodId: 17024101,
    prodName: '1G数据盘永久扩容',
    costPoints: 1200,
    prodType: 'pointsdiskupgrade',
    costPointType: POINT_TYPE.GENERAL,
    hardwareBound: true,
    description: '兑换后，将自动创建1个新数据盘，该盘仅支持积分扩容，最大不超过500GB',
  },
  {
    prodId: 17021101,
    prodName: '天翼AI云手机1个月试用',
    costPoints: 9000,
    prodType: 'pointscomputer',
    costPointType: POINT_TYPE.GENERAL,
    phoneBound: true,
    description: '权益：天翼AI云手机包月不限时，有效期1个月',
  },
  {
    prodId: 17022101,
    prodName: '游戏AI云电脑包月5小时试用',
    costPoints: 7500,
    prodType: 'pointscomputer',
    costPointType: POINT_TYPE.GENERAL,
    phoneBound: true,
    description: '权益：游戏AI云电脑包月5小时试用，有效期1个月',
  },
  {
    prodId: 17010101,
    prodName: '专属智库1G存储空间',
    costPoints: 1000,
    prodType: 'cpcai',
    costPointType: POINT_TYPE.GENERAL,
    description: '权益：基于当前AI应用中心存储空间，叠加1G存储空间，每月限兑5次',
  },
  {
    prodId: 17020101,
    prodName: 'AI应用中心高级版',
    costPoints: 1000,
    prodType: 'cpcai',
    costPointType: POINT_TYPE.GENERAL,
    description: '权益：AI应用中心高级版，支持DeepSeek满血版、专属智库等，有效期1个月',
  },
];

/**
 * 商品稳定规范排序：常用升配包（8C16G、16C32G）置顶，其余商品按积分梯级固定排序
 */
export function sortRewards(items: RewardItem[]): RewardItem[] {
  const priorityOrder = [
    17023101, // 8C16G升配包1天
    17023111, // 16C32G升配包1天
    17026101, // XC云电脑8C16G升配包
    17026111, // XC云电脑16C32G升配包
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
 * 判断商品是否已过期/未生效 (对齐官方 isExpired)
 */
function isRewardExpired(prod: { nowDate?: string; effDate?: string; expireDate?: string }): boolean {
  try {
    const now = prod.nowDate ? new Date(prod.nowDate) : new Date();
    if (prod.expireDate && now > new Date(prod.expireDate)) return true;
    if (prod.effDate && now < new Date(prod.effDate)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 查询当前用户对该商品的兑换次数统计 (对齐官方 listOrderInstStatisticsV2)
 * 返回 { orderCount: 本周期已兑换, totalCount: 总计已兑换 }
 */
export async function queryOrderStatistics(
  client: CtYunClient,
  reward: RewardItem,
  rawAttrs: any[] = [],
): Promise<{ orderCount: number; totalCount: number }> {
  const findAttr = (key: string) => rawAttrs.find((a) => a?.attrKey === key);
  const limitCalendarType = findAttr('pointExchangeInstLimitCalendarType');
  const totalCalendarType = findAttr('totalLimitCalendarType');
  const limitCalendarCnt = findAttr('pointExchangeInstLimitCalendarCnt');
  const totalCalendarCntDimension = findAttr('totalCalendarCntDimension');

  const entry: OrderStatisticsQuery = { prodIds: [reward.prodId] };
  if (limitCalendarType?.attrVal) entry.calendarType = String(limitCalendarType.attrVal);
  if (totalCalendarType?.attrVal) entry.totalCalendarType = String(totalCalendarType.attrVal);
  if (limitCalendarCnt?.attrVal) entry.calendarCnt = String(limitCalendarCnt.attrVal);
  if (totalCalendarCntDimension?.attrVal) entry.totalCalendarCntDimension = String(totalCalendarCntDimension.attrVal);

  try {
    const stats = await client.listOrderInstStatistics([entry as OrderStatisticsQuery]);
    const orderCount = Number(stats.currentUser?.[String(reward.prodId)]?.count ?? 0);
    const totalCount = Number(stats.totalUser?.[String(reward.prodId)]?.count ?? 0);
    return { orderCount, totalCount };
  } catch {
    return { orderCount: Number(reward.orderCount ?? 0), totalCount: Number(reward.totalCount ?? 0) };
  }
}

/**
 * 积分商城与自动兑换业务服务 (Reward & Redeem Service)
 *
 * 铁律规范：
 * 1. 严格对齐官方积分中心兑换参数 (pointType = costPointType, attrs 规则)
 * 2. 严格本地强比对：按 costPointType 对应积分类型校验余额，不足直接本地拦截
 * 3. 硬件绑定强校验：升配包与扩容盘必须校验绑定的有效 desktopId
 * 4. 兑换全流程审计闭环并记录日志
 */
export class RewardRedeemService {
  private static readonly DESK_URL = 'https://desk.ctyun.cn';

  /**
   * 查询官方在线在售积分商品 (严格对齐官方 points.html: prodId=17000000&prodCode=POINTS)
   * 过滤 prodStatus != 2 (非在售) 与已过期商品，并排除九江专属积分(20)商品
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
                // 官方过滤规则：仅保留在售且未过期的商品
                if (Number(sku.prodStatus) !== 2) continue;
                if (isRewardExpired(sku)) continue;

                const costPointType = Number(sku.costPointType ?? POINT_TYPE.GENERAL);
                // 九江专属积分(20)商品不纳入管理范围
                if (costPointType === POINT_TYPE.JIUJIANG) continue;
                let totalRedeemCount = -1;
                let totalLimitCalendarSize = -1;
                const attrs: any[] = Array.isArray(sku.attrs) ? sku.attrs : [];
                const findAttr = (key: string) => attrs.find((a) => a?.attrKey === key);
                const instAttr = findAttr('pointExchangeInstSize');
                if (instAttr) totalRedeemCount = Number(instAttr.attrVal) || -1;
                const totalAttr = findAttr('totalLimitCalendarSize');
                if (totalAttr) totalLimitCalendarSize = Number(totalAttr.attrVal) || 0;

                const prodId = Number(sku.prodId);
                rewards.push({
                  prodId,
                  prodName: String(sku.prodName || '').trim(),
                  costPoints: Number(sku.costPoints || 0),
                  prodType: String(sku.prodType || 'pointstplupgrade').trim(),
                  costPointType,
                  description: String(sku.description || series.description || '')
                    .replace(/<[^>]+>/g, '')
                    .trim(),
                  prodStatus: Number(sku.prodStatus),
                  effDate: sku.effDate,
                  expireDate: sku.expireDate,
                  orderCount: Number(sku.orderCount ?? 0),
                  userLimitCount: totalRedeemCount,
                  totalCount: Number(sku.totalCount ?? 0),
                  totalLimitSize: totalLimitCalendarSize,
                  hardwareBound:
                    sku.prodType === 'pointstplupgrade' ||
                    sku.prodType === 'pointsdiskupgrade' ||
                    HARDWARE_BOUND_PROD_IDS.includes(prodId),
                  phoneBound: PHONE_BOUND_PROD_IDS.includes(prodId),
                  rawAttrs: attrs.map((a) => ({ attrKey: String(a?.attrKey ?? ''), attrVal: a?.attrVal })),
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
  public static async resolveReward(
    client?: CtYunClient,
    prodId?: number,
    preloaded?: RewardItem[],
  ): Promise<RewardItem | undefined> {
    if (!prodId) return undefined;
    const numId = Number(prodId);

    // 优先复用调用方预加载的目录 (如 manager 内存缓存)，避免重复请求官方商城
    if (preloaded && preloaded.length > 0) {
      const hit = preloaded.find((i) => Number(i.prodId) === numId);
      if (hit) return hit;
    }

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
   * 提交兑换订单（严格对齐官方 placeOrder 参数与本地风控拦截）
   */
  public static async placeOrder(
    client: CtYunClient,
    desktopId?: string | number,
    prodId?: number,
    costPoints?: number,
    prodType?: string,
    options: { costPointType?: number; count?: number; mobilephone?: string } = {},
    rewardMeta?: RewardItem,
  ): Promise<{ success: boolean; message: string }> {
    if (!prodId) throw new Error('未提供目标商品 ID，无法发起兑换');

    let resolvedPoints = costPoints ? Number(costPoints) : 0;
    let resolvedType = prodType ? String(prodType).trim() : '';
    let resolvedPointType = options.costPointType !== undefined ? Number(options.costPointType) : 0;
    const count = Math.max(1, Number(options.count || 1));

    if (!resolvedPoints || !resolvedType || !resolvedPointType) {
      const item = rewardMeta || (await RewardRedeemService.resolveReward(client, Number(prodId)));
      if (item) {
        resolvedPoints = resolvedPoints || item.costPoints;
        resolvedType = resolvedType || item.prodType;
        resolvedPointType = resolvedPointType || item.costPointType || POINT_TYPE.GENERAL;
      }
    }

    if (!resolvedPoints || !resolvedType) {
      throw new Error(`未获取到商品 [${prodId}] 的规格参数(costPoints/prodType)，无法兑换`);
    }
    if (!resolvedPointType) resolvedPointType = POINT_TYPE.GENERAL;

    const numProdId = Number(prodId);
    const isHardwareBound =
      resolvedType === 'pointstplupgrade' || resolvedType === 'pointsdiskupgrade' || HARDWARE_BOUND_PROD_IDS.includes(numProdId);

    // 0. 实名认证前置校验 (对齐官方：云手机/游戏云电脑类商品需实名通过)
    if (PHONE_BOUND_PROD_IDS.includes(numProdId)) {
      try {
        const userInfo = await client.syncUserInfo();
        const realNameStatus = Number(userInfo?.realNameStatus);
        if (realNameStatus !== REAL_NAME_VERIFIED) {
          throw new Error(
            `[实名认证拦截] 商品 [${prodId}] 需完成实名认证后方可兑换 (当前状态码: ${realNameStatus ?? '未知'})`,
          );
        }
      } catch (err) {
        const msg = errorText(err);
        if (msg.includes('[实名认证拦截]')) throw err;
      }
    }

    // 0.1 限购与库存前置校验 (对齐官方 isDone / isCountNotEnough)
    try {
      const meta = rewardMeta || (await RewardRedeemService.resolveReward(client, numProdId));
      if (meta) {
        const { orderCount, totalCount } = await queryOrderStatistics(client, meta, meta.rawAttrs || []);
        const userLimit = Number(meta.userLimitCount ?? -1);
        const totalLimit = Number(meta.totalLimitSize ?? -1);
        if (userLimit !== -1 && orderCount + count > userLimit) {
          throw new Error(
            `[限购拦截] 商品 [${prodId}] 本周期限购 ${userLimit} 次，已兑换 ${orderCount} 次，本次请求 ${count} 份超出限制`,
          );
        }
        if (totalLimit > -1 && totalCount + count > totalLimit) {
          throw new Error(
            `[库存拦截] 商品 [${prodId}] 库存剩余 ${Math.max(0, totalLimit - totalCount)} 份，不足以兑换 ${count} 份`,
          );
        }
      }
    } catch (err) {
      const msg = errorText(err);
      if (msg.includes('[限购拦截]') || msg.includes('[库存拦截]')) throw err;
    }

    // 1. 积分硬性前置强校验：按 costPointType 对应积分类型校验真实可用积分
    try {
      const pointSummary = await PointsTask.getPointsAndTasks(client);
      const pointEntry = pointSummary.pointList.find((p) => p.pointType === resolvedPointType);
      const currentPoints = Number(
        pointEntry?.totalPoints ?? (resolvedPointType === POINT_TYPE.GENERAL ? pointSummary.generalPoints : 0),
      );
      const requiredPoints = resolvedPoints * count;
      if (currentPoints < requiredPoints) {
        throw new Error(
          `[积分不足拦截] 当前可用积分 ${currentPoints} 不足，兑换商品需要 ${requiredPoints} 积分，已放弃下单`,
        );
      }
    } catch (err) {
      const msg = errorText(err);
      if (msg.includes('[积分不足拦截]')) {
        throw err;
      }
    }

    // 2. 硬件绑定类商品校验（如升配包 pointstplupgrade、数据盘 pointsdiskupgrade）
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
    } else if (PHONE_BOUND_PROD_IDS.includes(numProdId)) {
      // 手机号绑定类商品（官方 attrs 规则：attrKey = mobilephone）
      const mobile = options.mobilephone || client.loginInfo?.mobilephone || client.loginInfo?.userAccount || '';
      if (!mobile) {
        throw new Error(`[参数错误拦截] 商品 [${prodId}] 需绑定手机号，但未获取到账号手机号`);
      }
      attrs.push({ attrKey: 'mobilephone', attrVal: mobile });
    } else if (isValidDesktopId) {
      attrs.push({ attrKey: 'bindDesktopId', attrVal: numDesktopId });
    }

    const url = `${RewardRedeemService.DESK_URL}/selforder/api/selforder/paas/placeOrder`;
    // 官方参数规则：pointType = costPointType，points = costPoints * 数量
    const payload = {
      busiChannel: '010',
      orderType: 1,
      pointType: resolvedPointType,
      points: Number(resolvedPoints) * count,
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
      message: `兑换成功！订单号: ${resJson.data?.orderId || '已生成'}，消耗 ${resolvedPoints * count} 积分`,
    };
  }

  /**
   * 兑换后生效重启 (升配/扩容类商品)
   * 官方处理订单为异步流程，立即重启会返回"正在执行系统任务，请稍后再试"，
   * 因此先等待订单生效，再按退避节奏重试重启。
   */
  public static async restartAfterRedeem(
    client: CtYunClient,
    desktopId: string,
    objType = 0,
    options: { initialDelayMs?: number; retries?: number; onWait?: (attempt: number, delayMs: number) => void } = {},
  ): Promise<void> {
    const retries = Math.max(1, options.retries ?? 4);
    let delay = Math.max(0, options.initialDelayMs ?? 15000);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await client.operateDesktop(desktopId, 'reset', objType);
        return;
      } catch (err) {
        const msg = errorText(err);
        const isBusy = msg.includes('正在执行') || msg.includes('请稍后') || msg.includes('任务') || msg.includes('处理中');
        if (!isBusy || attempt === retries) throw err;
        // 订单仍在处理中：退避重试，最长累计约 15s+30s+60s+120s
        delay = Math.min(delay * 2, 120000);
        options.onWait?.(attempt, delay);
      }
    }
  }
}
