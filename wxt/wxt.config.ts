import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  alias: { '@': '.' },
  manifest: {
    name: '微软积分自动奖励',
    description:
      '自动完成微软积分的每日搜索、每日任务与积分领取；可设定每天几点运行，也可一键手动运行。',
    // `version` is what the browsers compare to decide whether an update is newer,
    // so it stays numeric — a suffix like "-zh" there is rejected at load time.
    // `version_name` is the string the browser displays. The number deliberately
    // tracks the upstream release this fork is based on (3.1.2) rather than
    // out-ranking it: a fork cannot update the original listing anyway, and this
    // way the base stays obvious.
    version_name: '3.1.2-zh',
    // `cookies` reads the Rewards session inside the browser (Edge encrypts them
    // with App-Bound encryption, so nothing outside the browser can). `declarativeNetRequest`
    // is what attaches them to the API request: a `Cookie` header is a forbidden
    // header name for `fetch`, and the cookies themselves are SameSite=Lax, so a
    // cross-site request would otherwise arrive unauthenticated and get a 401.
    permissions: ['storage', 'alarms', 'scripting', 'cookies', 'declarativeNetRequest'],
    // The content scripts are declared below, but declarative injection alone
    // proved unreliable: a tab that was already open when the extension loaded or
    // reloaded never receives the script, and a browser may decline to run one at
    // all. `scripting` plus these host permissions let the background inject the
    // same bundle itself when messaging finds nobody listening, so the dashboard is
    // reached either way.
    host_permissions: ['https://rewards.bing.com/*', 'https://www.bing.com/*'],
    // One 512x512 file for every slot: build-icons.mjs writes the same rasterized
    // PNG for each size, so the extra names only carried duplicate bytes.
    icons: { 16: 'imgs/logo.png', 32: 'imgs/logo.png', 48: 'imgs/logo.png', 128: 'imgs/logo.png' },
    action: {
      default_icon: { 16: 'imgs/logo.png', 32: 'imgs/logo.png', 48: 'imgs/logo.png', 128: 'imgs/logo.png' },
      default_title: '微软积分自动奖励',
    },
    browser_specific_settings: {
      gecko: { id: 'microsoft_automatic_rewards@example.com', strict_min_version: '91.0' },
    },
  },
});
