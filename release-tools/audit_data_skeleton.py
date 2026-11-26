#!/usr/bin/env python3
"""出厂数据敏感审计 —— CI 门禁用。

按"值"反搜 data-skeleton/，不按 key 名猜。任何一条命中即退出 1，
release workflow 的 gate job 会跑这个，红就不打包。

本地也能跑：python3 release-tools/audit_data_skeleton.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(os.path.dirname(HERE), "data-skeleton")

VALUE_RULES = [
    ("私钥/密钥", re.compile(r"(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xoxb-|AKIA[0-9A-Z]{16})")),
    ("Bearer 明文", re.compile(r"Bearer\s+[A-Za-z0-9._\-]{12,}")),
    ("超长 token 串", re.compile(r"\b[A-Za-z0-9_\-]{40,}\b")),
    ("32位十六进制(openid类)", re.compile(r"\b[0-9A-Fa-f]{32}\b")),
    ("本机绝对路径", re.compile(r"/vol[1-4]/|/var/apps/|vector-nas")),
    ("内网 IP", re.compile(r"\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")),
    ("中国大陆手机号", re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("身份证号", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    ("真实邮箱", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}")),
]

WORD_RULES = [
    "王瑞兵", "姜楠", "姜亚楠", "河南大学", "刘彦随", "中国地质大学",
    "8232B16C", "4157152D", "ruibing", "沙库巴曲", "缬沙坦",
    "saviour.cc", "apikey.fan", "yimingtalk", "x666.me", "CUGB",
]

ALLOW = [
    "api.deepseek.com", "api.openai.com", "api.anthropic.com", "openrouter.ai",
    "api.github.com", "127.0.0.1", "localhost", "0.0.0.0",
    "hermes-agent.nousresearch.com", "q.qq.com", "%APPDATA%",
    "owner/repo", "example.com",
]

# 这几个段一旦非空就说明出厂配置被污染（无论值长什么样）
CONFIG_MUST_EMPTY = ["providers", "mcp_servers", "platforms", "fallback_providers"]


def main():
    if not os.path.isdir(ROOT):
        print(f"::error::找不到 {ROOT}")
        return 1

    red = 0
    checked = 0
    files = []
    for base, _dirs, names in os.walk(ROOT):
        for n in names:
            files.append(os.path.join(base, n))

    for path in sorted(files):
        rel = os.path.relpath(path, ROOT)
        try:
            raw = open(path, "rb").read()
        except OSError as e:
            print(f"[RED] {rel}: 读不了 {e}")
            red += 1
            continue
        if b"\x00" in raw[:4096]:
            continue
        try:
            txt = raw.decode("utf-8")
        except UnicodeDecodeError:
            print(f"[RED] {rel}: 非 UTF-8")
            red += 1
            continue
        checked += 1

        for name, pat in VALUE_RULES:
            for m in pat.finditer(txt):
                s = m.group(0)
                if any(a in s for a in ALLOW):
                    continue
                line = txt[: m.start()].count("\n") + 1
                print(f"::error file={rel},line={line}::{name} 命中: {s[:60]}")
                red += 1

        for w in WORD_RULES:
            if w in txt:
                line = txt[: txt.index(w)].count("\n") + 1
                print(f"::error file={rel},line={line}::敏感关键词 {w}")
                red += 1

    # config.yaml 结构闸
    cfg = os.path.join(ROOT, "config.yaml")
    if os.path.isfile(cfg):
        try:
            import yaml
            d = yaml.safe_load(open(cfg, encoding="utf-8")) or {}
            for k in CONFIG_MUST_EMPTY:
                if d.get(k):
                    print(f"::error file=config.yaml::{k} 必须为空，实际 {len(d[k])} 项（出厂配置被污染）")
                    red += 1
            m = d.get("model") or {}
            if m.get("provider") or m.get("default"):
                print(f"::error file=config.yaml::model 必须为空，实际 {m}")
                red += 1
        except ImportError:
            print("::warning::没装 pyyaml，跳过 config 结构校验")
        except Exception as e:
            print(f"::error file=config.yaml::解析失败 {e}")
            red += 1

    print(f"\n扫描 {checked} 个文件，红项 {red}")
    if red:
        print("::error::出厂数据含敏感内容，拒绝打包")
        return 1
    print("出厂数据审计通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
