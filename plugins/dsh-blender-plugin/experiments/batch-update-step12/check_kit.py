import importlib.util, os, sys, json
RT = r"\\wsl.localhost\Ubuntu\home\sixtyseven67\DSH\.scratch\step12\runtime"
spec = importlib.util.spec_from_file_location("offline_bootstrap", os.path.join(RT, "offline_bootstrap.py"))
ob = importlib.util.module_from_spec(spec); spec.loader.exec_module(ob)
K = sys.modules.get("dsh_rt_kernel")
if K is not None and hasattr(K, "dsh_kit"):
    try: delattr(K, "dsh_kit")
    except Exception: pass
ns = ob.boot([])
print("KIT_SELFTEST " + ns["K"].dsh_kit.selftest())
print("HAS_BATCH " + str(hasattr(ns["K"].dsh_kit, "BatchUpdates")))
