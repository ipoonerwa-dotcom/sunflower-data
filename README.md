# 向日葵团队业绩 · 自动更新

这个仓库只做一件事：**每 10 分钟**从 BNB Chain 读一次新数据，重新计算团队业绩，生成 `report.json`，用 GitHub Pages 发布出去。网站 <https://sunflower-web-lime.vercel.app/> 通过自己的域名转读这份数据，所以会员在哪里能打开网站，就能看到最新业绩。

**谁来触发**：cron-job.org 每 10 分钟调用一次 GitHub 接口启动它。不用 GitHub 自带的定时器：它忙时会晚跑甚至漏跑。

## 每次运行做什么

1. 取回上一次读过的链上数据，**只读新区块**（一次大约 20 次接口调用，Alchemy 免费额度只用到约 1/4）。读到最新区块往前约半分钟为止，不读还没稳定的最新几块。
2. 按业绩规则重新计算所有地址。
3. **和链上余额逐个地址对账**：报表持仓必须等于链上余额 + 借贷抵押 + 理财本金，一枚都不能差。
4. 对上了才发布。对不上会**自动重试一次**；还不行就**丢掉缓存、从头重读一遍**再对；仍然不行这次才不发布，网站继续显示上一份，GitHub 会发邮件提醒。

## 不会被一次卡住的运行堵死

新的一次运行会**直接取消还没结束的上一次**。正常一次只要半分钟，所以不会误伤；但如果某一次卡住不动，10 分钟后下一次触发就把它顶掉。

（2026-10-06 出过一次事故：一次运行卡在 GitHub 发布前的「等待」状态不动，当时的设置是"排队等上一次结束"，结果后面三天的每一次都排在它后面被丢弃，数据停更三天。）

## 需要的设置（只做一次）

- **Settings → Secrets and variables → Actions** 里加一个密钥 `RPC_URL`：Alchemy 的 BSC 主网地址。
- **Settings → Pages → Source** 选 **GitHub Actions**。
- **cron-job.org** 建一个任务，每 10 分钟：
  - URL：`https://api.github.com/repos/ipoonerwa-dotcom/sunflower-data/actions/workflows/update.yml/dispatches`
  - 方法 `POST`，请求体 `{"ref":"main"}`
  - 请求头：`Authorization: Bearer 你的令牌`（不要尖括号）、`Accept: application/vnd.github+json`、`Content-Type: application/json`
  - 令牌：GitHub 细粒度令牌，只授权这个仓库，权限 **Actions: Read and write**。**到期前要换新的**，否则 cron-job.org 会报 401，数据就停在最后一次。
  - 测试运行返回 **204** 就对了。
- **cron-job.org 再建一个监控任务**，每 15 分钟，打开「失败时通知」：
  - URL：`https://sunflower-web-lime.vercel.app/api/health`，方法 `GET`，不需要请求头。
  - 数据在 45 分钟内更新过，它返回 200；超过 45 分钟没更新，返回 503，cron-job.org 就会发邮件。
  - 上面那个触发任务每次都返回 204，**它成功不代表数据在更新**，所以要靠这个监控。

## 手动立刻更新一次

**Actions → 更新团队业绩数据 → Run workflow**。

## 查看运行情况

**Actions** 页面能看到每一次运行。绿色是成功；红色点进去可以看到哪一步失败；灰色「已取消」偶尔出现一次是正常的（被下一次顶掉），连续一大片就是出问题了。

发布出来的数据：<https://ipoonerwa-dotcom.github.io/sunflower-data/report.json>
