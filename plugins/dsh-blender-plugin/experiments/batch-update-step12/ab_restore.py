# -*- coding: utf-8 -*-
"""A/B：motion._restore_transforms 旧实现（逐对象 update） vs 新实现（一次 update）在真实成品场景上的耗时与还原正确性。"""
import importlib.util, json, os, sys, time

RT = r"\\wsl.localhost\Ubuntu\home\sixtyseven67\DSH\.scratch\step12\runtime"
OUT = r"D:/DSH/blender/tmp/restore_ab.json"
FILES = [
    ("行星发动机", r"D:/Blender/行星发动机/行星发动机.blend"),
    ("太空电梯", r"D:/Blender/太空电梯/SE_DELIVERY_MODEL.blend"),
]
N = 300

spec = importlib.util.spec_from_file_location("offline_bootstrap", os.path.join(RT, "offline_bootstrap.py"))
ob = importlib.util.module_from_spec(spec); spec.loader.exec_module(ob)
# headless 工具可能已注入旧版内核 kit（来自安装的插件 runtime）⇒ 强制用本工作树的 kit
_K = sys.modules.get("dsh_rt_kernel")
if _K is not None and hasattr(_K, "dsh_kit"):
    try:
        delattr(_K, "dsh_kit")
    except Exception:
        pass

ns = ob.boot(["motion"])
_mat_now = ns["_mat_now"]; _mat_of = ns["_mat_of"]; TOL = ns["TOL_MAT"]; _rl = ns["_rl"]
_snap_transforms = ns["_snap_transforms"]; _snap_diff = ns["_snap_diff"]
_restore_new = ns["_restore_transforms"]
import bpy


def restore_old(objs, snap, touched=None):
    touched = set(touched or [])
    bpy.context.view_layer.update()
    mism, pre_max, post_max, wrote = [], 0.0, 0.0, []
    for ob in objs:
        rec = snap.get(ob.name)
        if rec is None:
            mism.append({"name": ob.name, "reason": "快照里没有这个对象"})
            continue
        now = _mat_now(ob)
        d = max(abs(a - b) for a, b in zip(rec["matrix"], now))
        pre_max = max(pre_max, d)
        if d <= TOL and ob.name not in touched:
            post_max = max(post_max, d)
            continue
        try:
            if ob.rotation_mode != rec["mode"]:
                ob.rotation_mode = rec["mode"]
            for f, v in rec["fields"].items():
                setattr(ob, f, v)
            ob.matrix_parent_inverse = _mat_of({"matrix": rec["parent_inverse"]})
        except Exception as e:
            mism.append({"name": ob.name, "reason": "字段还原失败: %s" % str(e)[:120]})
            continue
        wrote.append(ob.name)
        bpy.context.view_layer.update()
        now2 = _mat_now(ob)
        d2 = max(abs(a - b) for a, b in zip(rec["matrix"], now2))
        if d2 > TOL:
            try:
                ob.matrix_world = _mat_of(rec)
                bpy.context.view_layer.update()
                now3 = _mat_now(ob)
                d3 = max(abs(a - b) for a, b in zip(rec["matrix"], now3))
                d2 = d3
                if d3 > TOL:
                    mism.append({"name": ob.name, "reason": "transform 未还原", "residual": d3})
            except Exception as e:
                mism.append({"name": ob.name, "reason": "矩阵还原失败: %s" % str(e)[:120]})
                continue
        post_max = max(post_max, d2)
    return mism, pre_max, post_max, wrote


def perturb(objs):
    for i, ob in enumerate(objs):
        ob.location.x += 1.0 + (i % 3) * 0.1
        ob.rotation_euler.y += 0.05
        ob.scale.z *= 1.001


def verify(objs, snap):
    want = {n: snap[n]["matrix"] for n in snap}
    got = {ob.name: _mat_now(ob) for ob in objs}
    mx, bad, exact = _snap_diff(want, got)
    return {"max_delta": mx, "bad": bad[:5], "bad_count": len(bad), "exact": exact}


def run(mode, objs, snap, fn):
    perturb(objs)
    t = time.perf_counter()
    mism, pre, post, wrote = fn(objs, snap)
    ms = (time.perf_counter() - t) * 1000.0
    return {"mode": mode, "ms": round(ms, 1), "wrote": len(wrote),
            "mismatches": len(mism), "mismatch_sample": mism[:2],
            "pre_max": pre, "post_max": post, "verify": verify(objs, snap)}


RES = {"blender": bpy.app.version_string, "n": N, "files": {}}
for label, path in FILES:
    rec = {}
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.wm.open_mainfile(filepath=path)
        objs = [o for o in bpy.data.objects if o.type == "MESH"][:N]
        snap = _snap_transforms(objs)
        rec["objects"] = len(objs)
        rec["old"] = run("old", objs, snap, restore_old)
        rec["new"] = run("new", objs, snap, _restore_new)
        rec["new2"] = run("new2", objs, snap, _restore_new)
        rec["ok"] = True
    except Exception as exc:
        import traceback
        rec["error"] = traceback.format_exc(limit=3)
    RES["files"][label] = rec

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(RES, f, ensure_ascii=False, indent=2)
print("AB_JSON " + json.dumps(RES, ensure_ascii=False))
