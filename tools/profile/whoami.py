#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SA 工作台 V2 · 个人中心 BUC 判活（移植自 base/sa-workbench tools/fetch/whoami.py）。

由本地桥 POST /local/profile/test 经 execFile('python3', [本脚本]) 调用：
  - Cookie 只来自环境变量 SA_SESSION_COOKIE（桥注入，只存在于本进程内存）；
  - 不读 Chrome / 不读 profile 文件 / 不接 argv 里的凭据；
  - 红线：cookie 值绝不进 stdout / stderr（错误 note 只含状态与端点信息）。

与 donor 的差异（按 V2 任务口径）：不再依赖 fetch_okr / sa_cookies 模块（自包含），
输出契约收敛为 {empId, name}；BUC 端点与失效判定语义保持不变：
  CRD /sso/login/user/info + window.USER_INFO 白名单抽取，302 → login.alibaba-inc.com
  或返回 SSO 登录页均判 expired。

输出契约（最后一行 JSON；前置告警行允许存在，桥按末行宽容解析）：
  成功  {"ok": true,  "empId": "...", "name": "..."}
  失败  {"ok": false, "code": "no_cookie|expired|no_user_info|no_emp|network|error", "note": "..."}

--parse <file>：离线解析本地 HTML/JS 片段里的 window.USER_INFO（自测用，不触网）。
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

CRD = "https://crd.aliyun-inc.com"
INFO_PATH = "/sso/login/user/info"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
NAME_RE = re.compile(r"^(.*?)\s*[(（]\s*(.*?)\s*[)）]\s*$")
USER_INFO_RE = re.compile(r"window\.USER_INFO\s*=\s*(\{.*?\});", re.S)
SCALAR_RE = re.compile(
    r"""["']?(\w+)["']?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([-+]?\d+(?:\.\d+)?)|true|false|null)"""
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁随跳转：302 → login.alibaba-inc.com 要以 HTTPError 形态暴露出来判 expired。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def js_scalars(blob):
    """JS 对象字面量 → 标量字典（只收字符串 / 数字 / 布尔 / null，嵌套结构忽略）。"""
    out = {}
    for m in SCALAR_RE.finditer(blob or ""):
        key = m.group(1)
        if m.group(2) is not None:
            out[key] = m.group(2)
        elif m.group(3) is not None:
            out[key] = m.group(3)
        elif m.group(4) is not None:
            out[key] = m.group(4)
        else:
            literal = m.group(0).split(":", 1)[1].strip()
            out[key] = {"true": True, "false": False, "null": None}[literal]
    return out


def parse_html(html):
    m = USER_INFO_RE.search(html or "")
    return js_scalars(m.group(1)) if m else None


def display_name(ui):
    """「真名(花名)」→ 花名优先（nickNameCn 更优先），无括号时整串作显示名（照 donor split_name）。"""
    raw = str((ui or {}).get("name") or "").strip()
    m = NAME_RE.match(raw)
    real, nick = (m.group(1).strip(), m.group(2).strip()) if m else (raw, "")
    nick_cn = str((ui or {}).get("nickNameCn") or "").strip()
    if nick_cn:
        nick = nick_cn
    return nick or real or raw


def identity(ui):
    emp = str((ui or {}).get("openId") or (ui or {}).get("empId") or "").strip()
    return emp, display_name(ui)


def whoami(cookie):
    if not cookie:
        return {"ok": False, "code": "no_cookie", "note": "未收到共享会话 Cookie（SA_SESSION_COOKIE 为空）：先在个人中心粘贴"}
    hdrs = {"Cookie": cookie, "User-Agent": UA, "Accept": "text/html,application/json"}
    last = ""
    for _ in range(2):
        req = urllib.request.Request(CRD + INFO_PATH, headers=hdrs)
        try:
            with OPENER.open(req, timeout=15) as r:
                body = r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location", "") if e.headers else ""
            if e.code in (301, 302, 303, 307, 308) and "login.alibaba-inc.com" in loc:
                return {"ok": False, "code": "expired", "note": "BUC 会话失效（302 → login.alibaba-inc.com），请重新粘贴 Cookie"}
            last = "HTTP %s" % e.code
            time.sleep(1)
            continue
        except Exception as e:  # noqa: BLE001
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
            time.sleep(1)
            continue
        if "ssoConfig" in body or "sso-civil" in body:
            return {"ok": False, "code": "expired", "note": "BUC 会话失效（返回 SSO 登录页），请续期后重新粘贴 Cookie"}
        ui = parse_html(body)
        if not ui:
            return {"ok": False, "code": "no_user_info", "note": "CRD 页面内未找到 window.USER_INFO（接口变更或会话异常）"}
        emp, name = identity(ui)
        if not emp:
            return {"ok": False, "code": "no_emp", "note": "USER_INFO 中无 openId（工号）"}
        return {"ok": True, "empId": emp, "name": name}
    return {"ok": False, "code": "network", "note": "CRD 请求失败：" + last}


def main(argv):
    if "--parse" in argv:
        fp = argv[argv.index("--parse") + 1]
        with open(fp, encoding="utf-8") as f:
            ui = parse_html(f.read())
        emp, name = identity(ui) if ui else ("", "")
        emit({"ok": bool(emp), "empId": emp, "name": name})
        return
    try:
        emit(whoami(os.environ.get("SA_SESSION_COOKIE", "")))
    except Exception as e:  # noqa: BLE001
        # 异常文本只含类型与前 160 字符（urllib 错误只带 URL，不带 Cookie 头）。
        emit({"ok": False, "code": "error", "note": "%s: %s" % (type(e).__name__, str(e)[:160])})


if __name__ == "__main__":
    main(sys.argv[1:])
