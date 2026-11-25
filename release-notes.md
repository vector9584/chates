# CHATÈS

## 安装

**Windows**：下载 `.exe`，双击安装，不需要另装 Node / Python。

已有用户升级时，配置保留在 `%APPDATA%\CHATÈS\data`，不会被覆盖。

**fnOS**：下载 `.fpk`，应用中心「手动安装」上传。

升级保留 `/vol1/@appdata/hermes-agent`（数据目录），配置不丢。

## 关于

两个包由同一份源码在 CI 现场构建，产物来自同一个 commit。

## 校验

```
sha256sum -c SHA256SUMS.txt
```

主页：https://vector9584.github.io/chates/
源码：https://github.com/vector9584/chates
