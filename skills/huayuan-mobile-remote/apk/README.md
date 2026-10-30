# 华园工作台 APK（随包分发）

`huayuan-workbench.apk` 是手机工作台的 Android 壳，构建源码在交付目录的 `android-app/`（不在本仓库内，
因为它是独立的 Gradle 工程）。放在这里是为了让**服务端能直接把它发给手机**：

```text
http://<电脑IP>:4320/download/app.apk
```

手机在同一个 Wi-Fi 下打开手机工作台，配对页底部有「装到手机桌面」入口，点一下就能下载安装，
装好后 App 会自动发现电脑，不用手抄 IP。

## 重新构建并替换

```powershell
# 源码位置：交付目录\android-app
cd <android-app 副本>
gradle assembleDebug
copy app\build\outputs\apk\debug\app-debug.apk <本目录>\huayuan-workbench.apk
```

- 包名 `com.huayuan.workbench`，minSdk 24（Android 7.0+），调试签名，体积约 35 KB；
- 版本号跟 `VERSION.md` / `plugin.json` 同步（当前 0.14.0）；
- 只申请网络权限，不收集数据；页面仍是服务端下发的同一套只读 PWA。

## 服务端怎么用它

`scripts/remote-server.js` 的 `GET /download/app.apk` 直接读本目录下的 APK，
带 `Content-Disposition: attachment`；文件不存在时返回 404，不影响页面其它功能。
