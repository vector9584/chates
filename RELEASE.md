# CHATES 发布流程

一条命令同时产出 **fpk（fnOS）** 和 **exe（Windows）**，同一 tag 合并到一个 Release。

## 平时怎么发

```bash
# 1. 改版本号（两处必须同步）
#    win/version.json        → 0.20.0-win.9
#    electron/package.json   → 0.20.9

# 2. 打 tag 推上去，CI 干活
git tag v0.20.0-win.9
git push origin v0.20.0-win.9
```

推到 tag 后 GitHub Actions 自动：
- `ubuntu-latest` 产 fpk
- `windows-latest` 产 exe
- 第三个 job 收齐两个产物，生成 `SHA256SUMS.txt`，建 Release

到 https://github.com/vector9584/chates/releases 看结果，两个文件都在才算成功。

## 本机调试

```bash
release-tools/publish.sh --tag v0.20.0-win.9 --dry          # 全链路校验，不产出、不推送
release-tools/publish.sh --tag v0.20.0-win.9 --local --only fpk   # 只在本机产 fpk（约 9 秒）
```

exe 只能在 Windows 上构建（NSIS 只出 Windows 目标，Linux 交叉编译签不了名、跑不了 `/S` 验收）。本机是 Linux 时 `build-exe.sh` 会自动降级为预检。

## 为什么资源不在仓库里

exe 需要 516 MB 资源树，进 git 会把仓库撑爆。所以 CI 现场重建：

| 组件 | 体积 | 来源 |
|---|---|---|
| `app/hermes-src`（内核） | 88 MB | git（**必须提交，否则 CI 跑不起来**） |
| `runtime/python` | 204 MB | CI 上用 `uv` 现装 |
| `runtime/node.exe` | 83 MB | nodejs.org 下载 |
| `app/{server,ui}` | 18 MB | git |
| `data/`（出厂数据） | 80 KB | `data-skeleton/`（脱敏骨架） |

每次发版都从源码重建，不会有陈旧二进制混进新版本。

## 凭据怎么处理

出厂 `data/` 用 `data-skeleton/`，它是从本机 `data/` 脱敏出来的：

- `.env` → `.env.example`，**122 个 key 的值全掩码**，只留 key 名和注释
- 技能库不进骨架（177 个技能文件里有真实姓名、域名、内网 IP）
- 生成后自动跑两道闸：明文凭据 grep + 环境指纹 grep

重新生成：

```bash
python3 release-tools/make-data-skeleton.py
```

它读本机 `data/`，跑完会打印掩码/保留统计，并在 `.skeleton-report` 留明细。**这个文件不进仓库。**

## 文件说明

| 文件 | 作用 |
|---|---|
| `release-tools/publish.sh` | 总控：校验 → 骨架 → fpk → exe → 发布 |
| `release-tools/build-fpk.sh` | 产 fpk。优先 `release-tools/vendor/fnpack`，无则手工 tar |
| `release-tools/build-exe.sh` | 产 NSIS 安装器。非 Windows 自动转预检 |
| `release-tools/release.sh` | 建 tag/Release，上传资产，生成 SHA256SUMS |
| `release-tools/make-data-skeleton.py` | 本机 data → 脱敏骨架 |
| `.github/workflows/release.yml` | 三 job：fpk / exe / publish |
| `release-tools/vendor/fnpack` | 飞牛打包器，静态链接 x86-64 单文件（3.7 MB） |

## 已知限制

- **`app/hermes-src` 必须提交进仓库**，否则 CI 的 fpk 和 exe job 都会在「准备内核源码」这步失败。这是当前唯一的硬依赖。
- `fnpack` 是飞牛专有工具，但静态编译、无动态依赖，所以能随仓库分发。已实测 `env -i` 干净环境下可直接运行。
- fpk 产物约 39 MB，比官方包的 68.9 MB 小，因为骨架不含技能库（官方包 40 个技能，仅 `trim-cli` 两个二进制就 16 MB）。要带技能得先做技能脱敏。
