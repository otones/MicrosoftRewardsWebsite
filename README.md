# 微软积分自动奖励 · 中文精简版

自动完成微软积分（Microsoft Rewards）的每日任务：**自动搜索、自动做每日任务、自动领取积分**。

这是一个**极简化的中文分支**：只保留扩展本身要做的三件事，去掉原版里的推广内容（免费游戏扩展、手机 App 二维码、捐赠入口、安装/卸载时的作者站点），并把界面完整本地化为中文。

版本：`3.12-zh`

## 功能

| 功能 | 说明 |
|---|---|
| 每日搜索 | 在后台按设定次数打开 Bing 搜索标签页，用自然词组合成查询、随机间隔，页面加载完成后自动关闭 |
| 每日任务 | 打开 Bing 积分页，自动点完当日的任务卡片 |
| 自动领取积分 | 自动点击「可领取」把积分入账（默认关闭，需自行开启） |
| 每天定时运行 | 可设定本地时间（默认 09:00）。到点自动开始；若那一刻浏览器没打开或电脑在睡眠，会在之后第一次有机会时补跑 |

也可以随时点弹窗里的「开始运行」手动跑一次。

## 安装

需要 Node.js 与 npm：

```bash
cd wxt
npm install
npm run build            # Chrome 产物：wxt/dist/chrome-mv3
```

然后在 Chrome 打开 `chrome://extensions` → 开启右上角「开发者模式」→「加载已解压的扩展程序」→ 选择 `wxt/dist/chrome-mv3`。

- Firefox：`npm run build:firefox`，产物在 `wxt/dist/firefox-mv2`。
- 开发调试：`npm run dev`（Chrome，热热重载）。

## 设计取向

极简：只做上面这三件事，不引入服务器、不采集数据、不做任何推广。

- 使用前请先在浏览器里登录微软账号（<https://www.microsoft.com/rewards>）。扩展不接触、也不保存你的账号密码。
- 没有服务器、没有统计上报：全部逻辑在本地运行，设置存在浏览器的同步/本地存储里。
- 自动化操作可能与微软积分的服务条款存在冲突，请自行判断并承担风险。

## 致谢

本分支基于 **[spin311/MicrosoftRewardsWebsite](https://github.com/spin311/MicrosoftRewardsWebsite)**（MIT 协议）修改而来。

感谢原作者 **[@spin311](https://github.com/spin311)** 的出色工作 —— 扩展的核心设计、搜索调度与页面交互逻辑都来自原项目。

- 原仓库：<https://github.com/spin311/MicrosoftRewardsWebsite>
- 如果你喜欢这个工具，也请去原仓库点个 star ⭐

## 许可

[MIT](LICENSE)
