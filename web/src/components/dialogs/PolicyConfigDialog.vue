<script setup lang="ts">
import { useAppStore } from '@/stores/app';
import { RefreshCw } from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { AppDialog } from '@/shared/ui/dialog';

const store = useAppStore();
</script>

<template>
  <AppDialog
    v-model:open="store.showPolicyModal"
    title="自动化任务与兑换策略"
    :description="`配置账号 [${store.policyAccount}] 的每日自动任务与积分兑换`"
    content-class="sm:max-w-md"
  >
    <div class="space-y-4">
      <!-- 模块 1: 每日自动 AI 对话任务 (06:00~08:00 随机错峰执行) -->
      <div class="p-4 rounded-xl bg-muted/40 border border-border/40 space-y-3.5">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-medium text-foreground">每日自动 AI 对话</div>
            <div class="text-xs text-muted-foreground">每日 06:00~08:00 随机错峰自动与 AI 对话 (+100 积分)</div>
          </div>
          <Switch v-model:checked="store.policyTaskEnabled" />
        </div>
      </div>

      <!-- 模块 2: 自动兑换 -->
      <div class="p-4 rounded-xl bg-muted/40 border border-border/40 space-y-3.5">
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-medium text-foreground">自动兑换商品</div>
            <div class="text-xs text-muted-foreground">周期到达时自动使用积分在官方商城兑换</div>
          </div>
          <Switch v-model:checked="store.policyRedeemEnabled" />
        </div>

        <div v-if="store.policyRedeemEnabled" class="pt-3 space-y-3 border-t border-border/40">
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">目标商品</label>
            <div class="flex items-center gap-2">
              <select
                v-model="store.policyTargetProdId"
                class="flex-1 h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
              >
                <option
                  v-for="item in store.policyRewards"
                  :key="item.prodId"
                  :value="item.prodId"
                >
                  {{ item.prodName }} ({{ item.costPoints }} 积分){{
                    typeof item.totalLimitSize === 'number' && item.totalLimitSize > -1
                      ? ` · 剩${Math.max(0, item.totalLimitSize - (item.totalCount || 0))}/${item.totalLimitSize}`
                      : ''
                  }}{{
                    typeof item.userLimitCount === 'number' && item.userLimitCount !== -1
                      ? ` · 本期已兑${item.orderCount || 0}/${item.userLimitCount}`
                      : ''
                  }}
                </option>
                <option v-if="store.policyRewards.length === 0" value="" disabled>
                  暂无官方商品数据
                </option>
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                class="h-9 px-2.5 text-xs gap-1 cursor-pointer shrink-0 border-border/60"
                :disabled="store.policyRewardsLoading"
                @click="store.refreshPolicyRewards()"
                title="从天翼云官方商城同步最新商品"
              >
                <RefreshCw class="size-3.5" :class="{ 'animate-spin': store.policyRewardsLoading }" />
                <span>刷新</span>
              </Button>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">单次兑换数量</label>
            <Input
              type="number"
              v-model="store.policyRedeemCount"
              min="1"
              max="500"
              class="h-9 text-xs"
            />
            <div class="text-[10px] text-muted-foreground">
              升配/扩容类商品官方要求兑换后重启云电脑方可生效，系统将自动下发重启指令
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">绑定云电脑实例</label>
            <select
              v-model="store.policyTargetDesktop"
              class="w-full h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">默认第一台云电脑</option>
              <option v-for="d in store.policyDesktops" :key="d.desktopCode" :value="d.desktopCode">
                {{ d.desktopName || '云电脑' }} ({{ d.desktopCode }})
              </option>
            </select>
          </div>

          <div class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">执行周期</label>
            <select
              v-model="store.policyScheduleType"
              class="w-full h-9 px-3 text-xs rounded-lg bg-background border border-input text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="interval_days">按间隔天数 (推荐每隔4天)</option>
              <option value="monthly_last_day">月末最后一天</option>
              <option value="monthly_day">每月固定日期</option>
              <option value="specific_date">指定具体日期</option>
              <option value="daily">每日自动执行</option>
            </select>
          </div>

          <!-- 周期参数输入 -->
          <div v-if="store.policyScheduleType === 'monthly_day'" class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">每月执行日 (1~31)</label>
            <Input
              type="number"
              v-model="store.policyMonthlyDay"
              min="1"
              max="31"
              class="h-9 text-xs"
            />
          </div>
          <div v-else-if="store.policyScheduleType === 'specific_date'" class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">选择指定日期</label>
            <Input
              type="date"
              v-model="store.policySpecificDate"
              class="h-9 text-xs"
            />
          </div>
          <div v-else-if="store.policyScheduleType === 'interval_days'" class="space-y-1.5">
            <label class="text-xs font-medium text-foreground">间隔天数</label>
            <Input
              type="number"
              v-model="store.policyIntervalDays"
              min="1"
              max="365"
              class="h-9 text-xs"
            />
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-2 w-full">
        <div>
          <Button
            v-if="store.policyRedeemEnabled"
            variant="secondary"
            size="sm"
            class="h-9 px-3 text-xs gap-1 cursor-pointer"
            @click="store.manualRedeem(store.policyAccount)"
            title="立即测试执行当前选中的商品兑换"
          >
            <span>立即兑换</span>
          </Button>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" class="h-9 cursor-pointer" @click="store.showPolicyModal = false">
            取消
          </Button>
          <Button
            class="h-9 shadow-xs cursor-pointer px-5"
            :disabled="store.policyLoading"
            @click="store.savePolicy"
          >
            {{ store.policyLoading ? '正在保存...' : '保存策略' }}
          </Button>
        </div>
      </div>
    </template>
  </AppDialog>
</template>
