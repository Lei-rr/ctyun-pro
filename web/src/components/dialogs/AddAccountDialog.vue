<script setup lang="ts">
import { useAppStore } from '@/stores/app';
import {
  CheckCircle2,
  RefreshCw,
  QrCode,
  KeyRound,
} from 'lucide-vue-next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { AppDialog } from '@/shared/ui/dialog';

const store = useAppStore();
</script>

<template>
  <AppDialog
    v-model:open="store.showModal"
    :title="store.modalStep === 'login' ? '添加天翼云账号' : '设备首次绑定短信认证'"
    :description="store.modalStep === 'login' ? '推荐微信或天翼云电脑 APP 扫码一键登录' : '新设备登录需手机短信确认绑定'"
    content-class="sm:max-w-md"
  >
    <div v-if="store.modalError" class="p-2.5 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-xs">
      {{ store.modalError }}
    </div>

    <!-- 步骤 1: 登录模式 (扫码登录 / 账号密码) -->
    <div v-if="store.modalStep === 'login'" class="space-y-3">
      <!-- 顶部模式切换 Segmented Control -->
      <div class="grid grid-cols-2 p-1 bg-muted/60 rounded-lg text-xs font-medium text-muted-foreground">
        <button
          type="button"
          @click="store.switchLoginMode('qrcode')"
          :class="[
            'py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5 cursor-pointer',
            store.loginMode === 'qrcode'
              ? 'bg-background text-foreground shadow-xs font-semibold'
              : 'hover:text-foreground',
          ]"
        >
          <QrCode class="size-3.5" />
          <span>微信 / APP 扫码</span>
        </button>
        <button
          type="button"
          @click="store.switchLoginMode('password')"
          :class="[
            'py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5 cursor-pointer',
            store.loginMode === 'password'
              ? 'bg-background text-foreground shadow-xs font-semibold'
              : 'hover:text-foreground',
          ]"
        >
          <KeyRound class="size-3.5" />
          <span>账号密码登录</span>
        </button>
      </div>

      <!-- 子视图 A: 扫码登录 -->
      <div v-if="store.loginMode === 'qrcode'" class="flex flex-col items-center py-1 space-y-3">
        <div class="w-full space-y-1">
          <label class="text-xs font-medium text-foreground">账号备注 (可选)</label>
          <Input
            type="text"
            v-model="store.formName"
            placeholder="自定义账号备注名称（如：办公云电脑）"
            class="h-9"
          />
        </div>

        <div
          class="relative w-48 h-48 rounded-xl border border-border bg-white p-2 flex items-center justify-center shadow-xs overflow-hidden"
        >
          <!-- 正在生成中 -->
          <div
            v-if="store.qrLoading || store.qrStatus === 'loading'"
            class="flex flex-col items-center gap-2 text-muted-foreground"
          >
            <RefreshCw class="size-6 animate-spin text-primary" />
            <span class="text-xs text-muted-foreground">生成二维码中...</span>
          </div>

          <!-- 二维码图像 -->
          <template v-else-if="store.qrImage">
            <img
              :src="store.qrImage"
              alt="天翼云扫码登录"
              class="w-full h-full object-contain pointer-events-none"
              :class="{
                'opacity-15 filter blur-[1px]': store.qrStatus === 'expire' || store.qrStatus === 'scaned',
              }"
            />

            <!-- 状态 1: 已扫码待确认 -->
            <div
              v-if="store.qrStatus === 'scaned'"
              class="absolute inset-0 bg-white/95 backdrop-blur-[2px] flex flex-col items-center justify-center p-4 text-center space-y-1.5 animate-in fade-in"
            >
              <div class="size-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <CheckCircle2 class="size-5" />
              </div>
              <div class="text-xs font-semibold text-emerald-800">已成功扫码</div>
              <div class="text-[11px] text-muted-foreground">请在手机端点击【确认登录】</div>
            </div>

            <!-- 状态 2: 已过期 -->
            <div
              v-if="store.qrStatus === 'expire'"
              class="absolute inset-0 bg-white/95 backdrop-blur-[2px] flex flex-col items-center justify-center p-4 text-center space-y-2"
            >
              <span class="text-xs font-medium text-destructive">二维码已失效</span>
              <Button
                size="sm"
                variant="outline"
                @click="store.initQrLogin()"
                class="h-7 px-3 text-xs cursor-pointer shadow-xs"
              >
                <RefreshCw class="size-3 mr-1" />
                点击刷新
              </Button>
            </div>
          </template>
        </div>

        <!-- 底部引导文案 -->
        <div class="text-center space-y-1">
          <div class="text-xs font-medium text-foreground flex items-center justify-center gap-1.5">
            <span class="relative flex h-2 w-2">
              <span
                class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"
              ></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>{{ store.qrStatus === 'scaned' ? '已扫码，等待手机确认...' : '打开手机扫一扫' }}</span>
          </div>
          <p class="text-[11px] text-muted-foreground">
            支持 <span class="text-foreground font-medium">微信</span> /
            <span class="text-foreground font-medium">天翼云电脑 APP</span> /
            <span class="text-foreground font-medium">翼连</span> 扫码
          </p>
        </div>
      </div>

      <!-- 子视图 B: 账号密码表单 (紧凑精致的间距) -->
      <form v-else @submit.prevent="store.submitLogin()" class="space-y-2.5">
        <div class="space-y-1">
          <label class="text-xs font-medium text-foreground">手机号码</label>
          <Input
            type="text"
            v-model="store.formUser"
            @input="store.onPhoneInput"
            placeholder="天翼云登录手机号"
            required
            class="h-9"
          />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-foreground">备注名称 (可选)</label>
          <Input
            type="text"
            v-model="store.formName"
            placeholder="默认与手机号相同"
            class="h-9"
          />
        </div>

        <div class="space-y-1">
          <label class="text-xs font-medium text-foreground">登录密码</label>
          <Input
            type="password"
            v-model="store.formPassword"
            placeholder="天翼云密码"
            required
            class="h-9"
          />
        </div>

        <!-- 图形验证码：对齐官方机制，仅在密码错误/需要验证码(needCaptcha)时平滑展开 -->
        <div v-if="store.needCaptcha" class="space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-foreground">图形验证码</label>
            <span class="text-[11px] text-muted-foreground">
              看图直填 (点击图片可换一张)
            </span>
          </div>
          <div class="flex items-center gap-2">
            <Input
              type="text"
              v-model="store.formCaptcha"
              placeholder="输入 4 位字符"
              :required="store.needCaptcha"
              class="flex-1 h-9 min-w-0 font-medium tracking-wider"
            />
            <div
              @click="store.refreshLoginCaptcha()"
              class="h-9 w-28 rounded-lg bg-muted/60 border border-border flex items-center justify-center cursor-pointer overflow-hidden hover:border-muted-foreground/50 transition-colors shrink-0 select-none p-0.5"
              title="点击换一张验证码"
            >
              <img
                v-if="store.captchaImgUrl"
                :src="store.captchaImgUrl"
                class="h-full w-full object-contain pointer-events-none rounded"
                alt="图形验证码"
              />
              <span v-else class="text-xs text-muted-foreground flex items-center gap-1">
                <RefreshCw v-if="store.captchaLoading" class="size-3.5 animate-spin" />
                <span v-else>点击获取</span>
              </span>
            </div>
          </div>
        </div>

        <div class="pt-1">
          <Button
            type="submit"
            :disabled="store.modalLoading"
            class="w-full h-9 shadow-xs cursor-pointer text-sm"
          >
            {{ store.modalLoading ? '正在登录验证...' : '确认并登录' }}
          </Button>
        </div>
      </form>
    </div>

    <!-- 步骤 2: 短信验证码表单 -->
    <div v-else class="space-y-3">
      <div class="space-y-1">
        <label class="text-xs font-medium text-foreground">第一步：获取短信图验</label>
        <div class="flex items-center gap-2">
          <Input
            type="text"
            v-model="store.smsCaptchaCode"
            placeholder="输入图验字符"
            class="flex-1 h-9 min-w-0"
          />
          <div
            @click="store.refreshSmsCaptcha()"
            class="h-9 w-28 rounded-lg bg-muted/60 border border-border flex items-center justify-center cursor-pointer overflow-hidden shrink-0 p-0.5"
            title="点击刷新短信图验"
          >
            <img v-if="store.smsCaptchaImgUrl" :src="store.smsCaptchaImgUrl" class="h-full w-full object-contain rounded" />
            <span v-else class="text-xs text-muted-foreground">刷新</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            @click="store.sendSms()"
            :disabled="store.modalLoading"
            class="h-9 text-xs shrink-0 cursor-pointer"
          >
            发送短信
          </Button>
        </div>
        <p v-if="store.smsSentSuccess" class="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1">
          <CheckCircle2 class="size-3.5" /> 短信已发出，请注意查收
        </p>
      </div>

      <div class="space-y-1">
        <label class="text-xs font-medium text-foreground">第二步：输入短信验证码</label>
        <Input
          type="text"
          v-model="store.smsVerificationCode"
          placeholder="6位短信验证码"
          class="h-9 font-mono tracking-widest"
        />
      </div>

      <div class="pt-1.5 flex gap-2 w-full">
        <Button
          type="button"
          variant="outline"
          @click="store.modalStep = 'login'"
          class="flex-1 h-9 cursor-pointer"
        >
          返回
        </Button>
        <Button
          type="button"
          @click="store.submitBindDevice()"
          :disabled="store.modalLoading"
          class="flex-1 h-9 shadow-xs cursor-pointer"
        >
          {{ store.modalLoading ? '正在绑定...' : '绑定并保活' }}
        </Button>
      </div>
    </div>
  </AppDialog>
</template>
