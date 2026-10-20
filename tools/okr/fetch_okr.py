#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SA 工作台 V2 · CRD（目标管理）OKR 快照取数（移植自 base/sa-workbench tools/fetch/fetch_okr.py）。

由本地桥 POST /local/okr/refresh 经 execFile('python3', [本脚本, '--out', <快照路径>]) 调用。

只读拉取 https://crd.aliyun-inc.com（donor 五端点原样保留）：
  1. /sso/login/user/info              → 身份（window.USER_INFO 白名单抽取）
  2. /api/v3/allPeriods                → 周期表，按 periodType=FY 且名称含当期 FY 定位年度周期
                                          （阿里财年 4 月起算，SA_OKR_PERIOD 可覆盖，如 FY26）
  3. /api/v3/objective/fullview        → O / KR / 权重 / 对齐 / 审批（唯一可用 OKR 端点）
  4. /api/v3/progress/objective/list   → 各 O 的 CRD 进展记录（timeDim=all）
  5. /api/v3/jobReview/*               → CRD 述职状态（仅取 currentPeriodReview.status）

与 donor 的差异（按 V2 任务口径）：
  - Cookie 只来自环境变量 SA_SESSION_COOKIE（桥注入，只存在于本进程内存），
    不再依赖 sa_cookies / Chrome 提取；缺失时立即失败，不触网；
  - 不再挂载本地述职文档（review.md/mount 为 donor S1 述职专属，超出本期范围）；
  - 产物只有 --out 指定的 okr.json（原子写 tmp+replace）+ 同目录 okr_raw_cache.json，
    不再输出 okr.js（V2 无 file:// 兜底页）。

安全红线：不落盘任何 cookie / token 值——身份字段走 SAFE_USER_KEYS 白名单，
所有落盘数据再过一遍 SECRET_KEY_RE 凭据键名剔除；stdout 只输出一行结果 JSON
（进度信息全走 stderr），note 不含 cookie。

输出契约（stdout 最后一行 JSON，桥按末行宽容解析）：
  成功  {"ok": true, "generatedAt": ..., "mode": "live|offline-cache",
         "period": {...}, "totals": {"oCount": n, "krCount": n, "crdProgressCount": n},
         "sizeKb": x}
  失败  {"ok": false, "code": "no_cookie|no_user|no_period|fetch_failed|error", "note": "..."}

用法：python3 tools/okr/fetch_okr.py --out <path>/okr.json [--offline]
"""
import argparse
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

CRD = "https://crd.aliyun-inc.com"
MY_OKR_URL = CRD + "/okr/my/owner"

# CRD 前端 bundle 中确认的枚举（app.min.js 6.0.22，照 donor）
KR_TYPE = {0: "无", 1: "承诺型", 2: "挑战型"}
O_TYPE = {"keynum": "关键结果指标", "business": "业务路径",
          "leadership": "建团队", "culture": "塑文化"}
AUDIT = {"APPROVED": "已通过", "PENDING_ASSESSMENT": "待评估", "NOT_APPROVED": "未通过",
         "NONE": "无审批"}

# 身份字段白名单：window.USER_INFO 是 JS 对象字面量且内含 tcsAuth 等凭据，
# 只按白名单抽取业务字段，并对所有落盘数据再做一次凭据键名剔除（照 donor）。
SAFE_USER_KEYS = ("id", "userId", "_id", "openId", "name", "nickNameCn", "teamId",
                  "language", "env", "empId", "email", "deptName", "deptNo",
                  "jobName", "isManager", "isInWhiteList")
SECRET_KEY_RE = re.compile(
    r"(token|auth|secret|cookie|passwd|password|signature|credential|accesskey|"
    r"access_key|ticket|jwt|session)", re.I)


def log(msg):
    """进度信息一律 stderr：stdout 只留给末行结果 JSON。"""
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def fail(code, note):
    emit({"ok": False, "code": code, "note": str(note)[:200]})
    sys.exit(1)


def current_fy(now=None):
    """阿里财年 4 月 1 日起算（FY27 = 2026-04 ~ 2027-03）；SA_OKR_PERIOD 可覆盖（如 FY26）。"""
    env = (os.environ.get("SA_OKR_PERIOD") or "").strip().upper()
    if env:
        return env
    t = now or datetime.now()
    return "FY%02d" % ((t.year + 1 if t.month >= 4 else t.year) % 100)


def atomic_write(fp, text):
    tmp = "%s.%d.tmp" % (fp, os.getpid())  # pid 后缀：并发刷新互不覆盖对方半成品
    os.makedirs(os.path.dirname(fp) or ".", exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, fp)


def stamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def js_scalars(blob):
    """从 JS 对象字面量里抽 key: 标量 键值对（不做完整 JS 解析，照 donor）。"""
    out = {}
    pat = re.compile(r'([A-Za-z_$][\w$]*)\s*:\s*(?:"((?:[^"\\]|\\.)*)"'
                     r"|'((?:[^'\\]|\\.)*)'|(true|false|null)|(-?\d+(?:\.\d+)?))")
    for m in pat.finditer(blob):
        k = m.group(1)
        if k in out:
            continue
        if m.group(2) is not None:
            v = m.group(2)
        elif m.group(3) is not None:
            v = m.group(3)
        elif m.group(4) is not None:
            v = m.group(4) == "true" if m.group(4) != "null" else None
        else:
            v = m.group(5)
            v = float(v) if "." in v else int(v)
        out[k] = v
    return out


def sanitize(obj):
    """递归剔除名字像凭据的键，保证产物可安全落盘 / 上页面（照 donor）。"""
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items() if not SECRET_KEY_RE.search(str(k))}
    if isinstance(obj, list):
        return [sanitize(x) for x in obj]
    return obj


# --------------------------------------------------------------------------
# CRD 只读拉取
# --------------------------------------------------------------------------
def build_session():
    """Cookie 只来自环境变量（桥经 execFile env 注入）；绝不读 argv / 文件 / Chrome。"""
    ck = (os.environ.get("SA_SESSION_COOKIE") or "").strip()
    if not ck:
        fail("no_cookie", "SA_SESSION_COOKIE 未注入：请先到「个人中心」配置 BUC 会话")
    return {
        "Cookie": ck,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": MY_OKR_URL,
        "X-Requested-With": "XMLHttpRequest",
    }


CTX = ssl._create_unverified_context()


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """跟随站内跳转，但拦下 login.alibaba-inc.com：那是会话失效信号（照 donor）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        if "login.alibaba-inc.com" in (newurl or ""):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(
    _SafeRedirect, urllib.request.HTTPSHandler(context=CTX))
SESSION_EXPIRED = "CRD 会话失效（302 → login.alibaba-inc.com）：用浏览器访问一次 CRD 即续期后重试"


def http(hdrs, path, params=None, method="GET", tries=3, timeout=25):
    """返回 (ok, payload_or_note)。NOT_LOGIN / 网络抖动自动重试（照 donor，只读通道）。"""
    if not path.startswith("/"):
        path = "/api/v3/" + path
    url = CRD + path
    if params:
        url += ("&" if "?" in path else "?") + urllib.parse.urlencode(params)
    last = ""
    for _ in range(tries):
        req = urllib.request.Request(url, headers=hdrs, method=method)
        try:
            with OPENER.open(req, timeout=timeout) as r:
                raw = r.read()
                ct = r.headers.get("Content-Type", "")
                if "json" not in ct:
                    body = raw.decode("utf-8", "ignore")
                    if "ssoConfig" in body or "sso-civil" in body:
                        last = SESSION_EXPIRED
                        time.sleep(1.0)
                        continue
                    return True, {"__html__": body}
                obj = json.loads(raw)
                if isinstance(obj, dict) and obj.get("errorCode") == "NOT_LOGIN":
                    last = SESSION_EXPIRED
                    time.sleep(1.2)
                    continue
                return True, obj
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location", "") if e.headers else ""
            if e.code in (301, 302, 303, 307, 308) and "login.alibaba-inc.com" in loc:
                last = SESSION_EXPIRED
                time.sleep(1.0)
                continue
            body = e.read()[:200].decode("utf-8", "ignore")
            last = "HTTP %d %s" % (e.code, body[:120])
            if e.code >= 500:
                time.sleep(1.2)
                continue
            return False, last
        except Exception as e:  # noqa: BLE001
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
            time.sleep(1.2)
    return False, last


def unwrap(obj):
    """CRD 返回体：{success, result|content|data}（照 donor）。"""
    if not isinstance(obj, dict):
        return obj
    for k in ("result", "content", "data"):
        if k in obj and obj[k] is not None:
            return obj[k]
    return obj


def fetch_crd(period):
    hdrs = build_session()
    raw = {"fetchedAt": stamp(), "errors": {}}

    # 1) 身份
    ok, r = http(hdrs, "/sso/login/user/info")
    uid = None
    if ok and isinstance(r, dict) and "__html__" in r:
        m = re.search(r"window\.USER_INFO\s*=\s*(\{.*?\});", r["__html__"], re.S)
        if m:
            scalars = js_scalars(m.group(1))
            ui = {k: v for k, v in scalars.items() if k in SAFE_USER_KEYS}
            raw["userInfo"] = ui
            uid = ui.get("id") or ui.get("userId") or ui.get("_id")
            if not uid:
                raw["errors"]["userInfo"] = "USER_INFO 白名单字段中无 id"
        else:
            raw["errors"]["userInfo"] = "页面内未找到 window.USER_INFO"
    elif not ok:
        raw["errors"]["userInfo"] = r
    if not uid:
        fail("no_user", "无法取得 CRD userId：" + str(raw["errors"].get("userInfo"))[:160])

    # 2) 周期：allPeriods 把周期分散在 currentPeriods / historyPeriods /
    #    historyGroupedPeriods[].periodList 三处，递归收全并按 _id 去重（照 donor）
    ok, r = http(hdrs, "allPeriods")
    periods, seen = [], set()
    pcount = {}
    if ok:
        pr = unwrap(r)
        if isinstance(pr, dict):
            pcount = pr.get("periodsObjectiveCount") or {}

        def walk(o):
            if isinstance(o, dict):
                if o.get("_id") and o.get("periodType"):
                    if o["_id"] not in seen:
                        seen.add(o["_id"])
                        periods.append(o)
                else:
                    for v in o.values():
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)

        walk(pr if isinstance(pr, (dict, list)) else [])
    else:
        raw["errors"]["allPeriods"] = r
    raw["periods"] = periods
    raw["periodsObjectiveCount"] = pcount

    fy = None
    for p in periods:
        nm = str(p.get("name") or p.get("bizName") or "")
        if p.get("periodType") == "FY" and nm.strip().upper() == period:
            fy = p
            break
    if not fy:  # 兜底：periodType=FY 且名称含当期 FY
        for p in periods:
            nm = str(p.get("name") or p.get("bizName") or "")
            if p.get("periodType") == "FY" and period in nm:
                fy = p
                break
    if not fy:
        fail("no_period", "未在 allPeriods 中定位到 %s 年度周期（共 %d 个周期）；"
             "可用 SA_OKR_PERIOD 指定，如 SA_OKR_PERIOD=FY26" % (period, len(periods)))
    pid = fy.get("_id") or fy.get("id")
    raw["periodFY"] = fy

    # 3) fullview（唯一可用 OKR 端点）
    ok, r = http(hdrs, "objective/fullview", {"userId": uid, "periodId": pid})
    if not ok:
        fail("fetch_failed", "objective/fullview 失败：" + str(r)[:160])
    raw["fullview"] = unwrap(r)

    # 4) 各 O 的 CRD 进展
    prog = {}
    for o in (raw["fullview"].get("objectives") or []):
        oid = o.get("_id") or o.get("objectiveId")
        ok2, r2 = http(hdrs, "progress/objective/list",
                       {"objectiveId": oid, "timeDim": "all"}, tries=2)
        if ok2:
            v = unwrap(r2)
            prog[oid] = v if isinstance(v, list) else (v.get("list") or [])
        else:
            prog[oid] = []
            raw["errors"]["progress:" + str(oid)] = r2
    raw["progress"] = prog

    # 5) CRD 述职状态（只取状态位，V2 不做述职挂载）
    ok3, r3 = http(hdrs, "jobReview/currentPeriodReview", tries=2)
    raw["review"] = {"currentPeriodReview": unwrap(r3) if ok3 else {"__error__": r3}}
    return sanitize(raw)


# --------------------------------------------------------------------------
# 组装（donor build() 去掉述职挂载部分；字段口径保持互逆于 okr_write.py）
# --------------------------------------------------------------------------
def build(raw, period, offline):
    fv = raw["fullview"]
    ex = (fv.get("auditInfo") or {}).get("okrExecutor") or fv.get("executor") or raw.get("userInfo") or {}
    per = (fv.get("auditInfo") or {}).get("period") or {}
    audit = fv.get("auditInfo") or {}

    objs = []
    for i, o in enumerate(fv.get("objectives") or [], 1):
        tname = o.get("objectiveTypeName") or ""
        tlabel = ((o.get("objectiveType") or {}).get("label")
                  or O_TYPE.get(tname) or tname or "未分类")
        krs = []
        for j, k in enumerate(o.get("keyResults") or [], 1):
            ind = k.get("krNumIndex") or {}
            has_ind = bool(ind.get("krId") or ind.get("targetValue"))
            # KR 自带 target/unit 恒为"完成度 100%"；真正的数值目标在 krNumIndex（照 donor）
            if has_ind and ind.get("targetValue") is not None:
                tgt = "%s %s" % (ind.get("targetValue"), ind.get("unit") or "")
            else:
                tgt = "完成度 %s%s" % (k.get("target"), k.get("unit") or "%")
            krs.append({
                "idx": "KR%d" % j,
                "id": k.get("_id"),
                "title": (k.get("title") or "").strip(),
                "weight": k.get("weight"),
                "type": k.get("type"),
                "typeLabel": KR_TYPE.get(k.get("type"), "未知"),
                "target": k.get("target"),
                "unit": k.get("unit"),
                "targetLabel": tgt.strip(),
                "start": k.get("start"),
                "progress": k.get("progress"),
                "status": k.get("status"),
                "hasIndices": bool(k.get("hasIndices")),
                "indicator": ({"targetValue": ind.get("targetValue"), "unit": ind.get("unit"),
                               "type": ind.get("type"), "currentValue": ind.get("currentValue"),
                               "krId": ind.get("krId")} if has_ind else None),
            })
        oid = o.get("_id") or o.get("objectiveId")
        prog = raw.get("progress", {}).get(oid) or []
        otitle = (o.get("title") or "").strip()
        objs.append({
            "idx": "O%d" % i,
            "id": oid,
            "type": o.get("type"),
            "typeName": tname,
            "typeLabel": tlabel,
            "weight": o.get("weight"),
            "status": o.get("status"),
            "title": otitle,
            "displayTitle": otitle or tlabel,
            "titleMissing": not otitle,
            "desc": (o.get("oDescription") or "").strip(),
            "progress": o.get("progress"),
            "teams": [t.get("name") for t in (o.get("teams") or []) if t.get("name")],
            "upAlign": [{"name": u.get("name"), "openId": u.get("openId"),
                         "dept": u.get("deptShortName")} for u in (o.get("upAlignUsers") or [])],
            "downAlignCount": o.get("downAlignCount") or 0,
            "krCount": len(krs),
            "keyResults": krs,
            "progressRecords": prog if isinstance(prog, list) else [],
            "period": {"name": (o.get("period") or {}).get("name"),
                       "start": (o.get("period") or {}).get("startDate"),
                       "end": (o.get("period") or {}).get("endDate")},
        })

    # 各周期 OKR 覆盖情况（前端周期切换列表）
    per_summary = []
    for p in raw.get("periods") or []:
        if not isinstance(p, dict):
            continue
        nm = str(p.get("name") or "")
        if not nm.startswith(period) and period not in str(p.get("bizName") or ""):
            continue
        per_summary.append({"id": p.get("_id") or p.get("id"), "name": nm,
                            "periodType": p.get("periodType"),
                            "duration": p.get("duration")})
    per_summary.sort(key=lambda x: (x["periodType"] or "", x["name"]))

    review = raw.get("review") or {}
    cur = review.get("currentPeriodReview") or {}
    crd_review_status = (cur.get("status") if isinstance(cur, dict) else None) or "NONE"

    return {
        "generatedAt": stamp(),
        "mode": "offline-cache" if offline else "live",
        "source": {"system": "CRD · 目标管理", "base": CRD, "myOkrUrl": MY_OKR_URL,
                   "api": ["GET /api/v3/objective/fullview", "GET /api/v3/allPeriods",
                           "GET /api/v3/progress/objective/list", "GET /api/v3/jobReview/*"],
                   "note": "浏览器受 CORS 与登录态限制无法直调内网，数据由本地桥 execFile 本脚本取得"},
        "errors": raw.get("errors") or {},
        "user": {"userId": ex.get("_id") or ex.get("id"), "openId": ex.get("openId"),
                 "name": ex.get("name"), "nick": ex.get("nickname"),
                 "email": ex.get("email"), "dept": ex.get("deptName"),
                 "deptNo": ex.get("deptNo"), "deptShort": ex.get("deptShortName"),
                 "job": ex.get("jobName")},
        "period": {"id": per.get("_id"), "name": per.get("name") or per.get("bizName"),
                   "periodType": per.get("periodType"), "duration": per.get("duration"),
                   "start": per.get("startDate"), "end": per.get("endDate")},
        "periodsFY": per_summary,
        "audit": {"status": audit.get("auditStatus"),
                  "statusLabel": AUDIT.get(audit.get("auditStatus"), audit.get("auditStatus")),
                  "gmtCreate": audit.get("gmtCreate"), "gmtAudit": audit.get("gmtAudit"),
                  "deadline": audit.get("deadline")},
        "hasValidOkr": fv.get("hasValidOkr"),
        "hiddenObjectiveCount": fv.get("hiddenObjectiveCount") or 0,
        "totals": {
            "oCount": len(objs),
            "krCount": sum(o["krCount"] for o in objs),
            "weightByO": {o["idx"]: o["weight"] for o in objs},
            "oWithoutKr": [o["idx"] for o in objs if o["krCount"] == 0],
            "crdProgressCount": sum(len(o["progressRecords"]) for o in objs),
            "crdReviewStatus": crd_review_status,
        },
        "objectives": objs,
        "review": {"crdStatus": crd_review_status,
                   "crdStatusLabel": {"NONE": "CRD 内未发起述职", "DRAFT": "草稿",
                                      "SUBMITTED": "已提交"}.get(crd_review_status, crd_review_status)},
    }


def main():
    ap = argparse.ArgumentParser(description="CRD OKR 快照取数（只读）")
    ap.add_argument("--out", required=True, help="快照输出路径（okr.json，原子写）")
    ap.add_argument("--offline", action="store_true",
                    help="跳过 CRD 拉取，用 --out 同目录 okr_raw_cache.json 重建快照")
    args = ap.parse_args()

    period = current_fy()
    out_json = os.path.abspath(args.out)
    raw_cache = os.path.join(os.path.dirname(out_json), "okr_raw_cache.json")

    if args.offline:
        if not os.path.exists(raw_cache):
            fail("error", "--offline 需要已有 %s" % raw_cache)
        raw = sanitize(json.load(open(raw_cache, encoding="utf-8")))
        log("[1/3] 使用 CRD 缓存（%s）" % raw.get("fetchedAt"))
    else:
        log("[1/3] 拉取 CRD（只读，不落任何凭据）...")
        try:
            raw = fetch_crd(period)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            fail("error", "%s: %s" % (type(e).__name__, str(e)[:160]))
        atomic_write(raw_cache, json.dumps(raw, ensure_ascii=False))

    log("[2/3] 组装快照 ...")
    data = build(raw, period, args.offline)
    t = data["totals"]
    log("      %s · %d O / %d KR / CRD 进展 %d 条 / 述职 %s" % (
        data["period"].get("name"), t["oCount"], t["krCount"],
        t["crdProgressCount"], t["crdReviewStatus"]))
    for k, v in (data["errors"] or {}).items():
        log("      ! %s → %s" % (k, str(v)[:100]))

    log("[3/3] 原子写快照 ...")
    atomic_write(out_json, json.dumps(data, ensure_ascii=False, indent=1))
    emit({"ok": True, "generatedAt": data["generatedAt"], "mode": data["mode"],
          "period": {"id": data["period"].get("id"), "name": data["period"].get("name"),
                     "periodType": data["period"].get("periodType")},
          "totals": {"oCount": t["oCount"], "krCount": t["krCount"],
                     "crdProgressCount": t["crdProgressCount"]},
          "sizeKb": round(os.path.getsize(out_json) / 1024, 1)})


if __name__ == "__main__":
    main()
