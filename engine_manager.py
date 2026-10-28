"""Stockfish 引擎管理：进程启动、配置、线程安全封装。

所有引擎调用都必须持有 engine_lock()，因为 python-chess 的 SimpleEngine
不是线程安全的。长任务（整局分析）应在每个位置之间释放锁，
让前端交互式请求可以插队。
"""
import atexit
import os
import subprocess
import threading

import chess.engine

from paths import BASE_DIR

_ENGINE_CANDIDATES = [
    os.path.join(BASE_DIR, "engines", "avx2", "stockfish", "stockfish-windows-x86-64-avx2.exe"),
    os.path.join(BASE_DIR, "engines", "baseline", "stockfish", "stockfish-windows-x86-64.exe"),
]

# GUI 模式下防止引擎子进程弹出控制台窗口
_POPEN_KWARGS = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

_lock = threading.RLock()
_engine = None
_engine_name = "未加载"
ENGINE_THREADS = max(1, min(8, (os.cpu_count() or 4) // 2))


class EngineError(RuntimeError):
    pass


def _spawn() -> None:
    global _engine, _engine_name
    last_err = None
    for path in _ENGINE_CANDIDATES:
        if not os.path.exists(path):
            continue
        eng = None
        try:
            eng = chess.engine.SimpleEngine.popen_uci(path, **_POPEN_KWARGS)
            eng.configure({
                "Threads": ENGINE_THREADS,
                "Hash": 256,
            })
            _engine = eng
            _engine_name = eng.id.get("name", "Stockfish") if isinstance(eng.id, dict) else str(eng.id)
            return
        except Exception as e:  # 尝试下一个候选二进制
            last_err = e
            if eng is not None:
                try:
                    eng.quit()
                except Exception:
                    pass
    detail = str(last_err) if last_err else "未找到引擎文件，请运行 python tools/get_engines.py"
    raise EngineError(f"无法启动 Stockfish: {detail}")


def engine_lock() -> threading.RLock:
    return _lock


def get_engine() -> chess.engine.SimpleEngine:
    global _engine
    with _lock:
        if _engine is None:
            _spawn()
        return _engine


def restart() -> str:
    """杀掉并重启引擎进程（用于异常恢复）。"""
    global _engine
    with _lock:
        quit_engine()
        get_engine()
        return _engine_name


def engine_name() -> str:
    get_engine()
    return _engine_name


def quit_engine() -> None:
    global _engine
    with _lock:
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:
                pass
            _engine = None


atexit.register(quit_engine)
