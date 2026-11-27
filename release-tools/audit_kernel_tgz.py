#!/usr/bin/env python3
"""内核包出厂审计 —— 判"哪些文件根本不该进包"。

和 audit_data_skeleton.py 的分工：
  · audit_data_skeleton  按【值】反搜，抓的是"内容里泄露了密钥/真名"
  · audit_kernel_tgz     按【路径与类别】判定，抓的是"这类东西压根不该出厂"

2026-11-27 起因：hermes_cli/web_dist 下 192 个中文名表情包被打进内核包，
除了携带聊天素材，还让 Windows 的 bsdtar 解压时整批报
"Invalid empty pathname"、返回 exit=1，直接把 1.20.7 的启动链判成失败。

用法：
  python3 release-tools/audit_kernel_tgz.py kernel/hermes-src.tgz
  python3 release-tools/audit_kernel_tgz.py <解压后的目录>
退出 0 = 干净，1 = 命中禁入项。
"""
import os
import sys
import tarfile

# 按类别禁入：路径里出现这些片段就判红。
# 加规则时写清"为什么"，否则半年后没人敢删。
FORBIDDEN_DIRS = [
    # 聊天素材：用户自己积累的表情包/贴纸，属内容产物不是程序功能。
    # 附带后果：中文文件名会让 Windows tar 整批报错并 exit=1。
    ("stickers", "聊天素材（表情包）不进安装包"),
    # 用户产生的文件：上传件、会话记录、日志、缓存、备份。
    ("uploads", "用户上传文件不进安装包"),
    ("sessions", "会话记录不进安装包"),
    ("cache", "运行时缓存不进安装包"),
    ("trash", "回收站不进安装包"),
    # 前端副本：内核只供 python 侧，前端一律以仓库 app/ui 为准。
    ("app/ui", "内核里的前端副本是死代码，会让人误判修复没进包"),
    ("app/echo-web", "示例前端不进内核"),
    # 开发期笔记与备份
    ("__pycache__", "字节码缓存不进包"),
    (".pytest_cache", "测试缓存不进包"),
]

# 路径里出现这些就禁入（非法凭据/本机痕迹）
FORBIDDEN_NAMES = [
    (".env", "真实 .env 绝不进包（改用 .env.example）"),
]

# 中文名文件：不禁止，但 Windows bsdtar 解压会报错并 exit=1，
# 需要人工确认是真功能文件（如文档）还是可剥的数据。
CJK_WARN = True


def scan_dir(root):
    hits = []
    warns = []
    total = 0
    for base, dirs, names in os.walk(root):
        rel_base = os.path.relpath(base, root)
        for d in list(dirs):
            p = "" if rel_base == "." else rel_base + "/"
            rel = (p + d).replace("\\", "/")
            for frag, why in FORBIDDEN_DIRS:
                if rel == frag or rel.endswith("/" + frag):
                    hits.append((rel, why))
        for n in names:
            total += 1
            p = "" if rel_base == "." else rel_base + "/"
            rel = (p + n).replace("\\", "/")
            for frag, why in FORBIDDEN_NAMES:
                if n == frag:
                    hits.append((rel, why))
            if CJK_WARN and any(ord(c) > 127 for c in n):
                warns.append(rel)
    return hits, warns, total


def scan_tgz(path):
    hits = []
    warns = []
    total = 0
    with tarfile.open(path, "r:gz") as tf:
        for m in tf:
            total += 1
            name = m.name.replace("\\", "/").lstrip("./")
            for frag, why in FORBIDDEN_DIRS:
                parts = name.split("/")
                for i in range(len(parts)):
                    tail = "/".join(parts[i:])
                    if tail == frag or tail.startswith(frag + "/"):
                        hits.append((name, why))
                        break
            if name == ".env" or name.endswith("/.env"):
                for frag, why in FORBIDDEN_NAMES:
                    hits.append((name, why))
            if CJK_WARN and any(ord(c) > 127 for c in os.path.basename(name)):
                warns.append(name)
    return hits, warns, total


def main():
    if len(sys.argv) < 2:
        print("用法: audit_kernel_tgz.py <tgz 或目录>")
        return 2
    target = sys.argv[1]
    if not os.path.exists(target):
        print("::error::找不到 %s" % target)
        return 1

    if os.path.isdir(target):
        hits, warns, total = scan_dir(target)
    else:
        hits, warns, total = scan_tgz(target)

    print("[audit] 目标: %s" % target)
    print("[audit] 条目数: %d" % total)

    if warns:
        # 只告警不判红：中文名文件可能是正常文档，但 Windows 解压会报错
        print("[audit] 提示: %d 个中文名文件（Windows bsdtar 解压会报 Invalid empty pathname，返回 exit=1）" % len(warns))
        for w in warns[:5]:
            print("        %s" % w)
        if len(warns) > 5:
            print("        ... 另有 %d 个" % (len(warns) - 5))

    if hits:
        print("")
        print("[audit] 命中禁入项 %d 个：" % len(hits))
        seen = set()
        for path, why in hits:
            key = why
            if key in seen:
                continue
            seen.add(key)
            print("  RED  %s" % why)
            print("       e.g. %s" % path)
        print("")
        print("::error::内核包含 %d 项不该出厂的内容，先改 make-kernel-tgz.sh 的 STRIP 清单" % len(hits))
        return 1

    print("[audit] 通过：无禁入项")
    return 0


if __name__ == "__main__":
    sys.exit(main())
