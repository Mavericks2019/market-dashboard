# 微信小程序版

## 本地预览

1. 安装并打开微信开发者工具。
2. 选择“导入项目”，目录选择仓库中的 `miniprogram` 文件夹。
3. 没有 AppID 时可先用测试号；准备发布时，把 `project.config.json` 中的 `appid` 换成自己的小程序 AppID。
4. 在 `config.js` 中保留 `http://127.0.0.1:4174`，先在仓库根目录运行 `npm ci`、`npm run build`，然后执行 `npm start` 启动后端。
5. 开发者工具中打开“详情 → 本地设置”，勾选“不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”，仅用于本地调试。

## 真机和发布

1. 把 Node 后端部署到可公网访问的 HTTPS 域名，例如 `https://market-api.example.com`。
2. 将该域名加入微信公众平台的“开发管理 → 开发设置 → 服务器域名 → request 合法域名”。
3. 将 `config.js` 的 `API_BASE_URL` 改为此 HTTPS 地址。
4. 微信开发者工具中用真实 AppID 编译、真机预览并上传代码。

正式版不能请求 `localhost`、IP 地址或未配置的 HTTP 域名。

## 从注册到小程序码

1. 在 [微信公众平台](https://mp.weixin.qq.com/) 注册“小程序”帐号并完善主体、管理员、名称、头像和服务类目。
2. 在“开发管理 → 开发设置”取得 AppID，替换 `project.config.json` 中的 `touristappid`。
3. 部署后端并配置 HTTPS。在“开发管理 → 开发设置 → 服务器域名”中把域名加入 `request 合法域名`，域名不带接口路径。
4. 在微信开发者工具内关闭“不校验合法域名”后重新编译，并使用“预览”在真机测试首页、周期切换、下拉刷新和弱网状态。
5. 点击开发者工具顶部“上传”，填写版本号和项目备注。
6. 登录微信公众平台，在“版本管理 → 开发版本”中选择该版本。可先设为体验版，让体验成员扫码测试。
7. 点击“提交审核”，填写服务类目、功能说明、测试路径等资料。行情类目的具体资质以该帐号后台当前可选项为准。
8. 审核通过后，在“版本管理 → 审核版本”点击“发布”。
9. 发布后在小程序后台下载正式小程序码；体验阶段只能使用体验版二维码，且仅体验成员可打开。

微信官方参考：[接入指南](https://developers.weixin.qq.com/miniprogram/introduction/)、[开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)、[网络与服务器域名](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[发布流程](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html)、[小程序码](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/qr-code.html)。
