# 向日葵团队业绩 · 自动更新

这个仓库只做一件事：**每 15 分钟**从 BNB Chain 读一次新数据，重新计算团队业绩，生成 `report.json`，用 GitHub Pages 发布出去。网站 <https://sunflower-web-lime.vercel.app/> 通过自己的域名转读这份数据，所以会员在哪里能打开网站，就能看到最新业绩。

## 每次运行做什么

1. 取回上一次读过的链上数据，**只读新区块**（一次大约 20 次接口调用，Alchemy 免费额度只用到约 1/5）。
2. 按业绩规则重新计算所有地址。
3. **和链上余额逐个地址对账**：报表持仓必须等于链上余额 + 借贷抵押 + 理财本金，一枚都不能差。
4. 对上了才发布；对不上，这次就不发布，网站继续显示上一份，GitHub 会发邮件提醒。

## 需要的设置（只做一次）

- **Settings → Secrets and variables → Actions** 里加一个密钥 `RPC_URL`：Alchemy 的 BSC 主网地址。
- **Settings → Pages → Source** 选 **GitHub Actions**。

## 手动立刻更新一次

**Actions → 更新团队业绩数据 → Run workflow**。

## 查看运行情况

**Actions** 页面能看到每一次运行。绿色是成功；红色点进去可以看到哪一步失败（多半是 Alchemy 一时连不上，下一次会自动重试）。

发布出来的数据：`https://<账号>.github.io/<仓库名>/report.json`

代码的原件在项目目录 `sunflower-team` 里，这里是导出的副本（`node tools/export-data-repo.js`），改代码请在原件里改。
