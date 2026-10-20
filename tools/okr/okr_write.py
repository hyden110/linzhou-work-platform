#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SA 工作台 V2 · CRD（目标管理）OKR 写通道（移植自 base/sa-workbench tools/sync/okr_write.py）。

由本地桥 POST /local/okr/sync-dry、/local/okr/sync-confirm 经
execFile('python3', [本脚本, '--edits', <file>, ('--confirm'), ('--accept-conflicts')]) 调用：

  1. GET /api/v3/objective/user/find?objectiveId=  → 拉该 O 的 CRD 完整原值
  2. 本地 patch：O(title / oDescription / weight)、KR(title / weight /
     krNumIndex.targetValue | unit)——字段映射与 fetch_okr.py 的 build() 严格互逆
  3. PUT  /api/v3/objective/user/update（data = patch 后整棵 O 对象，
     KR 数组随 O 整体提交，与 CRD 前端 bundle 6.0.22 的调用形态一致）

安全契约（外部写红线，照 donor 原样保留）：
  - 默认 dry-run：只 find + 输出差异，绝不落笔；--confirm 才真正 PUT。
  - 冲突项（CRD 当前值 ≠ edits.from）默认跳过，--accept-conflicts 才覆盖。
  - PUT 不做 NOT_LOGIN 自动重试（避免写半次重放）；cookie 只在本进程内使用。

与 donor 的差异（按 V2 任务口径）：Cookie 只来自环境变量 SA_SESSION_COOKIE
（桥注入，只存在于本进程内存），不再依赖 sa_cookies / Chrome 提取；
无合法编辑项时在触网前正常返回（exit 0），供离线自测。

用法：python3 tools/okr/okr_write.py --edits <file> [--confirm] [--accept-conflicts]
输出：stdout 最后一行 JSON（供桥末行宽容解析）；任何失败退出码 1。
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CRD = "https://crd.aliyun-inc.com"
MY_OKR_URL = CRD + "/okr/my/owner"

# 快照字段 → CRD 原始字段（与 fetch_okr.py build() 的抽取方向互逆，照 donor）
O_FIELD = {"title": "title", "desc": "oDescription", "weight": "weight"}
KR_FIELD = {"title": "title", "weight": "weight"}
KR_IND_FIELD = {"targetValue": "targetValue", "unit": "unit"}

CTX = ssl._create_unverified_context()


def build_session():
    """Cookie 只来自环境变量（桥经 execFile env 注入）；绝不读 argv / 文件 / Chrome。"""
    ck = (os.environ.get("SA_SESSION_COOKIE") or "").strip()
    if not ck:
        return None
    return {
        "Cookie": ck,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": MY_OKR_URL,
        "X-Requested-With": "XMLHttpRequest",
    }


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    """站内跳转跟随，但拦下 login.alibaba-inc.com（会话失效信号，照 donor）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        if "login.alibaba-inc.com" in (newurl or ""):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(_SafeRedirect, urllib.request.HTTPSHandler(context=CTX))
SESSION_EXPIRED = "CRD 会话失效（302 → login.alibaba-inc.com）：用浏览器访问一次 CRD 即续期后重跑"


def http(hdrs, path, params=None, method="GET", body=None, tries=3, timeout=25):
    """返回 (ok, payload_or_note)。GET 可对 NOT_LOGIN 重试；PUT（body 非空）不重写重试。"""
    if not path.startswith("/"):
        path = "/api/v3/" + path
    url = CRD + path
    if params:
        url += ("&" if "?" in path else "?") + urllib.parse.urlencode(params)
    last = ""
    for _ in range(tries):
        hdrs2 = dict(hdrs)
        payload = None
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs2["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=payload, headers=hdrs2, method=method)
        try:
            with OPENER.open(req, timeout=timeout) as r:
                raw = r.read()
                ct = r.headers.get("Content-Type", "")
                if "json" not in ct:
                    body_txt = raw.decode("utf-8", "ignore")
                    if "ssoConfig" in body_txt or "sso-civil" in body_txt:
                        last = SESSION_EXPIRED
                        time.sleep(1.0)
                        continue
                    return False, "非 JSON 响应（疑似登录壳页）"
                obj = json.loads(raw)
                if isinstance(obj, dict) and obj.get("errorCode") == "NOT_LOGIN":
                    if body is not None:
                        return False, SESSION_EXPIRED  # 写请求不做会话重试
                    last = SESSION_EXPIRED
                    time.sleep(1.2)
                    continue
                return True, obj
        except urllib.error.HTTPError as e:
            loc = e.headers.get("Location", "") if e.headers else ""
            if e.code in (301, 302, 303, 307, 308) and "login.alibaba-inc.com" in loc:
                if body is not None:
                    return False, SESSION_EXPIRED
                last = SESSION_EXPIRED
                time.sleep(1.0)
                continue
            detail = e.read()[:200].decode("utf-8", "ignore")
            last = "HTTP %d %s" % (e.code, detail[:120])
            if e.code >= 500 and body is None:
                time.sleep(1.2)
                continue
            return False, last
        except Exception as e:  # noqa: BLE001
            last = "%s: %s" % (type(e).__name__, str(e)[:120])
            if body is not None:
                return False, last
            time.sleep(1.2)
    return False, last


def unwrap(obj):
    """CRD 返回体：{success, result|content|data} → 业务对象（照 donor）。"""
    if not isinstance(obj, dict):
        return None
    for key in ("result", "content", "data"):
        v = obj.get(key)
        if isinstance(v, dict):
            return v
    return obj if "_id" in obj or "objectiveId" in obj else None


def norm(v):
    """值统一成字符串再比较（快照与 CRD 的数字/字符串口径可能不同）。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def coerce(field, to):
    """weight 转数字；其余保持字符串（CRD 的 targetValue 即字符串，如 '7.4'）。"""
    if field == "weight":
        try:
            return int(to)
        except (TypeError, ValueError):
            try:
                return float(to)
            except (TypeError, ValueError):
                return to
    return to


def find_kr(obj, kr_id):
    for k in obj.get("keyResults") or []:
        if k.get("_id") == kr_id:
            return k
    return None


def crd_current(obj, item):
    """在 find 到的 O 对象上读该 edit 字段的 CRD 当前值（norm 后字符串）。"""
    if item["kind"] == "o":
        return norm(obj.get(O_FIELD[item["field"]]))
    kr = find_kr(obj, item.get("krId"))
    if kr is None:
        return None  # KR 已不在（可能被删除）
    f = item["field"]
    if f in KR_FIELD:
        return norm(kr.get(KR_FIELD[f]))
    return norm((kr.get("krNumIndex") or {}).get(KR_IND_FIELD[f]))


def apply_patch(obj, item):
    """把单条 edit 写进 find 结果对象（donor 同语义：仅作用于即将 PUT 的副本）。"""
    f = item["field"]
    if item["kind"] == "o":
        obj[O_FIELD[f]] = coerce(f, item["to"])
        return True, ""
    kr = find_kr(obj, item.get("krId"))
    if kr is None:
        return False, "该 KR 已不在 CRD 的 keyResults 中（可能被删除），跳过"
    if f in KR_FIELD:
        kr[KR_FIELD[f]] = coerce(f, item["to"])
        return True, ""
    ind = kr.get("krNumIndex")
    if not isinstance(ind, dict) or not (ind.get("krId") or ind.get("targetValue")):
        return False, "该 KR 无数值指标（krNumIndex），请先在 CRD 端创建后再同步目标值"
    ind[KR_IND_FIELD[f]] = coerce(f, item["to"])
    return True, ""


def load_edits(fp):
    doc = json.load(open(fp, encoding="utf-8"))
    items = []
    for it in doc.get("edits") if isinstance(doc, dict) else []:
        if not isinstance(it, dict):
            continue
        kind, f = it.get("kind"), it.get("field")
        if kind not in ("o", "kr") or not it.get("oId"):
            continue
        legal = (O_FIELD if kind == "o" else dict(KR_FIELD, **KR_IND_FIELD))
        if f not in legal:
            continue
        if kind == "kr" and not it.get("krId"):
            continue
        items.append({"kind": kind, "oId": it["oId"], "krId": it.get("krId") if kind == "kr" else None,
                      "field": f, "from": it.get("from"), "to": it.get("to")})
    return doc, items


def main():
    ap = argparse.ArgumentParser(description="CRD OKR 写通道（find → patch → update）")
    ap.add_argument("--edits", required=True, help="待同步编辑 JSON（桥暂存的 edits.json / edits.confirm.json）")
    ap.add_argument("--confirm", action="store_true", help="真正 PUT（默认 dry-run 只看差异）")
    ap.add_argument("--accept-conflicts", action="store_true", dest="accept_conflicts",
                    help="CRD 当前值与导出原值不同的冲突项也覆盖")
    args = ap.parse_args()

    if not os.path.exists(args.edits):
        print(json.dumps({"ok": False, "mode": "dry-run", "results": [],
                          "note": "待同步文件不存在：" + os.path.basename(args.edits)}, ensure_ascii=False))
        sys.exit(1)
    try:
        doc, items = load_edits(args.edits)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "mode": "dry-run", "results": [],
                          "note": "待同步文件解析失败：" + str(e)[:120]}, ensure_ascii=False))
        sys.exit(1)
    mode = "confirm" if args.confirm else "dry-run"
    if not items:
        # 触网前正常返回：没有合法编辑项就没有可写内容（离线自测也依赖该短路）。
        print(json.dumps({"ok": True, "mode": mode, "results": [],
                          "note": "文件中没有合法的待同步编辑"}, ensure_ascii=False))
        return

    hdrs = build_session()
    if hdrs is None:
        print(json.dumps({"ok": False, "mode": mode, "results": [],
                          "note": "SA_SESSION_COOKIE 未注入：请先到「个人中心」配置 BUC 会话"}, ensure_ascii=False))
        sys.exit(1)

    by_o = {}
    for it in items:
        by_o.setdefault(it["oId"], []).append(it)

    results, failed = [], 0
    for o_id, o_items in by_o.items():
        ok, payload = http(hdrs, "/api/v3/objective/user/find", params={"objectiveId": o_id})
        if not ok or not isinstance(payload, dict):
            for it in o_items:
                results.append({**it, "crd": None, "state": "failed",
                                "note": "find 失败：" + norm(payload)})
                failed += 1
            continue
        obj = unwrap(payload)
        if not isinstance(obj, dict) or not obj.get("_id"):
            for it in o_items:
                results.append({**it, "crd": None, "state": "failed",
                                "note": "find 返回体无目标对象（结构异常）"})
                failed += 1
            continue

        patched = 0
        for it in o_items:
            cur = crd_current(obj, it)
            it_res = {**it, "crd": cur, "state": "pending", "note": ""}
            if cur is None and it["kind"] == "kr":
                it_res.update(state="kr-missing", note="该 KR 已不在 CRD（可能被删除）")
            elif cur == norm(it["to"]):
                it_res.update(state="already", note="CRD 当前值与目标值一致，无需写")
            elif cur != norm(it["from"]) and not args.accept_conflicts:
                it_res.update(state="conflict",
                              note="CRD 当前值与导出原值不同（他人已改），默认跳过")
            else:
                if args.confirm:
                    ok2, note = apply_patch(obj, it)
                    if not ok2:
                        it_res.update(state="failed", note=note)
                        failed += 1
                    else:
                        patched += 1
                        it_res["state"] = "written"
                # dry-run 保持 pending（展示将写什么）
            results.append(it_res)

        # 该 O 有落笔项 → 整树 PUT（dry-run 不发）
        if patched:
            ok3, resp = http(hdrs, "/api/v3/objective/user/update", method="PUT",
                             body=obj, tries=1)
            success = ok3 and isinstance(resp, dict) and resp.get("success") is not False
            if not success:
                failed += patched
                note = resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)[:160]
                for r in results:
                    if r["oId"] == o_id and r["state"] == "written":
                        r.update(state="failed", note="update 失败：" + note)
            else:
                print("[ok] O %s 已更新（%d 项）" % (o_id[-4:], patched), file=sys.stderr)

    out = {
        "ok": failed == 0,
        "mode": mode,
        "acceptConflicts": bool(args.accept_conflicts),
        "baseSnapshotAt": doc.get("baseSnapshotAt") if isinstance(doc, dict) else "",
        "wrote": sum(1 for r in results if r["state"] == "written"),
        "results": results,
        "note": "",
    }
    if mode == "dry-run":
        pend = sum(1 for r in results if r["state"] == "pending")
        out["note"] = "dry-run：未写任何数据；%d 项待同步，%d 项冲突跳过" % (
            pend, sum(1 for r in results if r["state"] == "conflict"))
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(1 if failed or (mode == "confirm" and out["wrote"] == 0 and any(
        r["state"] not in ("already", "conflict", "kr-missing") for r in results)) else 0)


if __name__ == "__main__":
    main()
