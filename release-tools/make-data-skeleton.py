#!/usr/bin/env python3
"""
make-data-skeleton.py — 从本机 data/ 生成「可公开的出厂骨架」。

问题的形状：
  data/.env 里既有凭据（QQ_CLIENT_SECRET、NAS_SSH_PASS）又有配置
  （DISCORD_HOME_CHANNEL、FEISHU_DOMAIN）。整个删掉 → 用户装完没有默认配置；
  整个保留 → 142 条凭据进公开 Release。

  所以不能按「文件」决策，得按「这一行是什么」决策。

判定策略（宁可多掩，不可漏掩）：
  1. key 命中敏感名单            → 必掩
  2. value 形态像密钥（长度/high-entropy/prefix）→ 掩
  3. value 是路径/URL/host/布尔/数字 → 保留
  4. 拿不准                      → 掩

产物：
  data-skeleton/      可入公开仓库（已脱敏）
  .skeleton-report    记录掩码了哪些 key，供人工复核（不进仓库）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

REDACTED = "[REDACTED]"

# key 名里出现这些词，一律当凭据（不看 value 形态）
SENSITIVE_KEY = re.compile(
    r"(PASS|PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|_KEY|KEY$|CRED|CREDENTIAL|"
    r"AUTH|PRIVATE|_SK$|SK$|COOKIE|SESSION|SIGNATURE|SALT|DSN|CONNECTION|"
    r"ACCOUNT_ID|APP_ID|CLIENT_ID|_ID$|USER$|USERNAME|_USER|LOGIN|PHONE|MOBILE|"
    r"EMAIL|MAIL_USER|ADMIN|BT_USER|ADMIN_PASS)",
    re.I,
)

# 策略：**默认掩码，只放行这里列出的**。
# 曾经反过来做（形态判断能过就留），实测漏掉 ROUTER_PWD、STUDENT_NO ——
# 「看起来像配置」和「可以公开」不是一回事。凭据闸只认白名单。
KEEP_EXCEPTIONS = {
    # 消息渠道的公开标识（频道号/域名/模式），不含认证
    "DISCORD_HOME_CHANNEL", "DISCORD_HOME_CHANNEL_NAME", "DISCORD_ALLOWED_USERS",
    "DISCORD_FREE_RESPONSE_CHANNELS",
    "FEISHU_HOME_CHANNEL", "FEISHU_HOME_CHANNEL_NAME", "FEISHU_ALLOWED_USERS",
    "FEISHU_DOMAIN", "FEISHU_CONNECTION_MODE",
    "TELEGRAM_ALLOWED_USERS", "QQ_ALLOWED_USERS",
    # 服务地址（URL 本身不是密钥）
    "WEIXIN_BASE_URL", "NOWEN_API_BASE", "NOWEN_READER_URL", "QB_API_BASE",
    "GITEA_URL", "ROUTER_URL", "ECS_BT_URL", "HERMES_SHARE_BASE",
    "YCALENDAR_BASE_URL", "YCALENDAR_PUBLIC_URL", "YCALENDAR_CALDAV_PATH",
    "ZOTERO_WEBDAV_URL",
    # 非密钥的枚举/类型
    "ZOTERO_LIBRARY_TYPE", "BAIKAL_USER_DISPLAY", "CUGB_MOBILE_SCHOOL",
    # 主机与端口（连不上任何东西，凭据在别处）
    "NAS_SSH_HOST", "NAS_SSH_PORT", "NAS_TRIM_HOST", "NAS_TRIM_PORT", "ECS_HOST",
}

# 注意：**用户名不在白名单**。用户名单独看无害，但配合密码就是完整凭据，
# 而公开包的读者不需要知道你的 NAS 账号叫什么。2026-11-25 实测漏过
# NAS_SSH_USER / NOWEN_USERNAME / QB_USERNAME / JABLE_USERNAME / BAIMIAO_USER。

# value 形态判断：这些看起来是普通配置，可以留
CONFIG_VALUE = re.compile(
    r"^(true|false|yes|no|on|off|auto|manual|"
    r"\d+|"
    r"/[\w./@-]*|"                      # 绝对路径
    r"[A-Za-z]:[\\/][\w./\\ -]*|"       # Windows 路径
    r"https?://[\w./:@-]+|"             # URL（不含 ?token= 之类）
    r"[\w-]+(\.[\w-]+)+/?|"             # 域名
    r"[a-z_][a-z0-9_-]*|"               # 小写标识符
    r"[\w-]+,[\w-]*)$",                 # 逗号列表
    re.I,
)

# 值里出现这些片段，无论多长都当凭据
SECRET_HINT = re.compile(
    r"(Bearer |sk-|ghp_|github_pat_|xox[baprs]-|AKIA|-----BEGIN|"
    r"eyJ[a-zA-Z0-9_-]{10,}|"            # JWT
    r"[A-Za-z0-9+/]{32,}={0,2})",       # base64 长串
)

# 纯数字/纯主机名/单字母之类的小值不用管
TRIVIAL = re.compile(r"^(\d{1,6}|[a-z]{1,3}|)$", re.I)


def looks_secret(key: str, val: str) -> bool:
    """这一行的 value 该不该掩。"""
    v = val.strip()
    if not v:
        return False
    if TRIVIAL.match(v):
        return False
    if SECRET_HINT.search(v):
        return True
    if CONFIG_VALUE.match(v):
        return False
    # 长无空格串（>=20 且不含路径分隔），当密钥
    if len(v) >= 20 and " " not in v and "/" not in v and "\\" not in v:
        return True
    return False


def sanitize_env(src: Path, dst: Path, report: list[dict]) -> None:
    out_lines: list[str] = []
    for raw in src.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.rstrip("\n")
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            out_lines.append(line)
            continue
        key, val = m.group(1), m.group(2)

        # 白名单：保留 key 名，但**值也清空**。
        # 频道 ID、内网主机名不是密码，可它们是你环境的指纹，公开包里没必要带。
        # 用户第一次启动自己填；空值不会让程序崩（monitor.js 读 .env 有 try/catch）。
        if key in KEEP_EXCEPTIONS:
            out_lines.append(f"{key}=")
            report.append({"key": key, "action": "blank(whitelist)", "reason": "公开配置项，值清空"})
            continue

        # 默认掩码。key 名敏感 → 记原因；否则也掩，因为形态判断已证明不可靠。
        if SENSITIVE_KEY.search(key):
            out_lines.append(f"{key}={REDACTED}")
            report.append({"key": key, "action": "redact", "reason": "key名敏感"})
            continue

        if looks_secret(key, val):
            out_lines.append(f"{key}={REDACTED}")
            report.append({"key": key, "action": "redact", "reason": "值形态像密钥"})
            continue

        # 既不在白名单、也不像密钥 —— 仍然掩掉，但标出来让人复核。
        # 这条是 2026-11-25 的教训：ROUTER_PWD 因为值是短字符串被判成「配置」漏了出去。
        out_lines.append(f"{key}={REDACTED}")
        report.append({"key": key, "action": "redact", "reason": "默认掩码(未在白名单)"})

    dst.write_text("\n".join(out_lines) + "\n", encoding="utf-8")


def sanitize_config(src: Path, dst: Path, report: list[dict]) -> None:
    """config.yaml 里也可能嵌着 api_key（Hermes 允许把 key 写在 config 里）。"""
    text = src.read_text(encoding="utf-8", errors="replace")
    out = []
    for line in text.splitlines():
        m = re.match(r"^(\s*(?:api_key|api_secret|token|password|secret)\s*:\s*)(.+)$", line, re.I)
        if m and m.group(2).strip() not in ("", "null", "~", '""', "''"):
            out.append(f"{m.group(1)}{REDACTED}")
            report.append({"key": "(config.yaml)", "action": "redact", "reason": line.strip()[:40]})
        else:
            out.append(line)
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    src = root / "electron" / "resources" / "chates" / "data"
    dst = root / "data-skeleton"

    if not src.is_dir():
        print(f"源 data 不存在: {src}", file=sys.stderr)
        print("先跑 electron/assemble.sh 或用 --from 指定", file=sys.stderr)
        return 1

    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    report: list[dict] = []

    # .env：逐行分类
    env_src = src / ".env"
    if env_src.is_file():
        sanitize_env(env_src, dst / ".env.example", report)
    print(f"  .env        -> .env.example（已脱敏）")

    # config.yaml：清内嵌 key
    cfg_src = src / "config.yaml"
    if cfg_src.is_file():
        sanitize_config(cfg_src, dst / "config.yaml", report)
        print(f"  config.yaml -> config.yaml（已清内嵌凭据）")

    # 人格/行为/笔记：原样保留，这是产品的一部分不是秘密
    for name in ("SOUL.md", "AGENTS.md", "notes.md"):
        f = src / name
        if f.is_file():
            shutil.copy2(f, dst / name)
            print(f"  {name:<11} -> 原样保留")

    # 技能库：**不进公开骨架**。
    # 2026-11-25 实测：169 个技能文件含真实姓名、GitHub 账号、私有域名
    # ruibing.wang、内网 IP 192.168.3.110。技能库是用户的知识资产（100MB+），
    # 不是产品出厂内容——它是「这个用户怎么干活」，不是「Hermes 是什么」。
    # 想要技能的装机：从私有渠道拷，或首次启动后自己装。
    keep_skills = os.environ.get("SKELETON_INCLUDE_SKILLS") == "1"
    sk = src / "skills"
    if sk.is_dir():
        if keep_skills:
            shutil.copytree(sk, dst / "skills")
            n = sum(1 for _ in (dst / "skills").rglob("SKILL.md"))
            print(f"  skills/     -> 已包含（{n} 个技能）⚠ 含环境指纹，仅限私有分发")
            report.append({"key": "(skills/)", "action": "included", "reason": "显式要求，私有分发用"})
        else:
            (dst / "skills").mkdir()
            (dst / "skills" / ".gitkeep").write_text("")
            print(f"  skills/     -> 空占位（技能库不外发）")

    # scripts：同样含本机路径与账号，不外发
    sc = src / "scripts"
    if sc.is_dir():
        if keep_skills:
            shutil.copytree(sc, dst / "scripts")
            print(f"  scripts/    -> 已包含 ⚠ 仅限私有分发")
        else:
            (dst / "scripts").mkdir()
            (dst / "scripts" / ".gitkeep").write_text("")
            print(f"  scripts/    -> 空占位")

    # memories / knowledge 属于用户私有内容，不进公开骨架
    # 空目录占位，让首次启动有落点
    for d in ("memories", "knowledge"):
        (dst / d).mkdir(exist_ok=True)
        (dst / d / ".gitkeep").write_text("")

    # ---- 环境指纹闸 ----
    # SSOT 文件（.env / AGENTS.md / SOUL.md）是用户的正本，不能改源。
    # 但它们里面天然带着个人域名、内网 IP、任务表入口——这些不该随公开包外发。
    # 所以对产物做一次文本替换，把指纹换成占位符。
    FINGERPRINTS = [
        (re.compile(r"https?://ruibing\.wang\S*"), "https://<your-domain>/..."),
        (re.compile(r"\b192\.168\.\d+\.\d+\b"), "<LAN-IP>"),
        (re.compile(r"\b10\.\d+\.\d+\.\d+\b"), "<LAN-IP>"),
        (re.compile(r"vector9584"), "<github-user>"),
        (re.compile(r"王瑞兵"), "<name>"),
    ]
    hits = 0
    for f in dst.rglob("*"):
        if not f.is_file() or f.suffix not in (".md", ".yaml", ".example", ""):
            continue
        try:
            t = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        orig = t
        for pat, rep in FINGERPRINTS:
            t, n = pat.subn(rep, t)
            hits += n
        if t != orig:
            f.write_text(t, encoding="utf-8")
    if hits:
        print(f"  环境指纹: 替换 {hits} 处（域名/内网IP/账号名）")

    # 复核报告（不进仓库）
    rep = root / ".skeleton-report"
    lines = [f"{r['action']:<16} {r['key']:<36} {r['reason']}" for r in report]
    redacted = sum(1 for r in report if r["action"].startswith("redact"))
    rep.write_text(
        f"# data 骨架脱敏报告\n# 共 {len(report)} 个 key，掩码 {redacted} 个\n\n"
        + "\n".join(lines) + "\n",
        encoding="utf-8",
    )
    print(f"\n  掩码 {redacted} / {len(report)} 个 key，报告: .skeleton-report")
    return 0


if __name__ == "__main__":
    sys.exit(main())
