# 下载与代理

## 为什么需要这个

Release 页的大文件挂在 `objects.githubusercontent.com` 上。这台机器（北京，家宽）实测：

| 目标 | 速度 |
|---|---|
| `objects.githubusercontent.com` 直连 | **20–68 KB/s** |
| `ghproxy.net` 前置代理 | **371 KB/s** |
| `api.github.com` asset 端点 + `curl -C -` | ~195 KB/s |

151 MB 的 `CHATES-Setup-*.exe` 直连要一个多小时，挂代理大约七分钟。

## 怎么用

把原始下载链接整个拼在代理域名后面：

```
https://ghproxy.net/https://github.com/vector9584/chates/releases/download/<tag>/<file>
```

例如：

```
https://ghproxy.net/https://github.com/vector9584/chates/releases/download/v0.20.0-win.10/CHATES-Setup-0.20.10.exe
```

浏览器地址栏直接粘就能下，不需要注册。

## 实测过的代理（2026-11-26，Windows + 系统自带 curl.exe）

| 前缀 | 连通 | 速度 |
|---|---|---|
| `https://ghproxy.net/` | ✅ | **371 KB/s** |
| `https://gh-proxy.com/` | ✅ | 未测（连通性通过） |
| 直连（不加前缀） | ✅ | 20–68 KB/s |
| 其它几个常见镜像 | ❌ | 超时或 404 |

**测速方法**（PowerShell 5.1 里没有 `System.Net.Http`，必须用系统 `curl.exe`）：

```powershell
curl.exe -L --max-time 30 -o NUL -w "%{speed_download}\n" `
  "https://ghproxy.net/https://github.com/vector9584/chates/releases/download/v0.20.0-win.10/latest.yml"
```

## 下载后校验

```bash
sha256sum hermes-agent_0.21.153.fpk
# 42ac724b5ca9e6aed0310dc5cb4afa33cfd1bfe083e7c38898173d8860dbc634
```

Windows：

```powershell
Get-FileHash .\hermes-agent_0.21.153.fpk -Algorithm SHA256
```

## 断点续传

大文件中断了不用重下，`curl` 自带续传：

```powershell
curl.exe -L -C - -o CHATES-Setup-0.20.10.exe `
  "https://ghproxy.net/https://github.com/vector9584/chates/releases/download/v0.20.0-win.10/CHATES-Setup-0.20.10.exe"
```

`-C -` 会从本地已有的字节处接着下。第三方代理不一定支持 Range 请求——不支持时会从头开始，不会写坏文件。

## 已知坑

- **代理不是永久的**。这类免费加速站随时可能关停或限速，脚本里别写死，出错要能退回直连。
- **`raw.githubusercontent.com` 和 `objects.githubusercontent.com` 在这台机器上都不通/被限速**，但 `api.github.com` 正常。所以拉文件元信息可以用 API，拉文件本体得走代理。
- **PS 5.1 的 `Invoke-WebRequest` 在 151 MB 上会卡住不报错**，用 `curl.exe`。
