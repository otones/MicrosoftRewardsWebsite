import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  alias: { '@': '.' },
  manifest: {
    name: '微软积分自动奖励',
    description:
      '自动完成微软积分的每日搜索、每日任务与积分领取；可设定每天几点运行，也可一键手动运行。',
    permissions: ['storage', 'alarms'],
    icons: { 16: 'imgs/logo.png', 32: 'imgs/logo2.png', 48: 'imgs/logo2.png', 128: 'imgs/logo3.png' },
    action: {
      default_icon: { 16: 'imgs/logo.png', 32: 'imgs/logo2.png', 48: 'imgs/logo2.png', 128: 'imgs/logo3.png' },
      default_title: '微软积分自动奖励',
    },
    browser_specific_settings: {
      gecko: { id: 'microsoft_automatic_rewards@example.com', strict_min_version: '91.0' },
    },
  },
});
