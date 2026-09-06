"""stfchess — 基于 Stockfish 的国际象棋棋步/棋局分析工具（Web 服务）。

启动: .venv/Scripts/python -m uvicorn server:app --host 127.0.0.1 --port 8134
"""
from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Optional

import chess
import chess.engine
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import analysis
import engine_manager
from paths import BASE_DIR

STATIC_DIR = Path(BASE_DIR) / "static"

DEFAULT_DEPTH = 12
DEFAULT_CAP = 2.5  # 单个局面分析的时间上限（秒）

app = FastAPI(title="stfchess", version="1.0")

# ----------------------------- 引擎调用辅助 -----------------------------

def run_with_engine(fn):
    """在引擎锁内执行 fn(engine)，并处理引擎崩溃自动重启。"""
    with engine_manager.engine_lock():
        engine = engine_manager.get_engine()
        try:
            return fn(engine)
        except chess.engine.EngineError:
            engine_manager.restart()
            raise HTTPException(503, "引擎进程异常，已自动重启，请重试")


# ----------------------------- 请求/响应模型 -----------------------------

class FenIn(BaseModel):
    fen: str


class MoveIn(BaseModel):
    fen: str
    from_sq: str = Field(alias="from")
    to_sq: str = Field(alias="to")
    promotion: Optional[str] = None

    model_config = {"populate_by_name": True}


class AnalyzeIn(BaseModel):
    fen: str
    depth: int = DEFAULT_DEPTH
    multipv: int = 3
    cap: float = DEFAULT_CAP


class EngineMoveIn(BaseModel):
    fen: str
    level: int = 2  # 1弱 2中 3强 4最强


class ParsePgnIn(BaseModel):
    pgn: str


class AnalyzeJobIn(BaseModel):
    initial_fen: str = chess.STARTING_FEN
    moves: list[str]
    depth: int = DEFAULT_DEPTH
    cap: float = 2.0


class ExportIn(BaseModel):
    headers: dict = {}
    initial_fen: str = chess.STARTING_FEN
    moves: list[str]
    analysis: list[dict] = []


# ----------------------------- 基础接口 -----------------------------

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    try:
        name = engine_manager.engine_name()
    except Exception as e:
        raise HTTPException(503, f"引擎不可用: {e}")
    return {
        "engine": name,
        "python_chess": chess.__version__,
        "threads": max(1, (__import__("os").cpu_count() or 4) - 1),
    }


@app.post("/api/position/moves")
def position_moves(req: FenIn):
    try:
        board = chess.Board(req.fen)
    except ValueError as e:
        raise HTTPException(400, f"无效 FEN: {e}")
    promo_names = {chess.QUEEN: "q", chess.ROOK: "r", chess.BISHOP: "b", chess.KNIGHT: "n"}
    moves = []
    for mv in board.legal_moves:
        moves.append({
            "from": chess.square_name(mv.from_square),
            "to": chess.square_name(mv.to_square),
            "san": board.san(mv),
            "uci": mv.uci(),
            "promotion": promo_names.get(mv.promotion),
            "capture": board.is_capture(mv),
            "check": board.gives_check(mv),
        })
    check_sq = None
    if board.is_check():
        check_sq = chess.square_name(board.king(board.turn))
    return {"moves": moves, "turn": "w" if board.turn == chess.WHITE else "b", "check_sq": check_sq}


@app.post("/api/position/move")
def position_move(req: MoveIn):
    try:
        board = chess.Board(req.fen)
    except ValueError as e:
        raise HTTPException(400, f"无效 FEN: {e}")
    uci = req.from_sq + req.to_sq + (req.promotion or "")
    try:
        mv = chess.Move.from_uci(uci)
    except ValueError:
        raise HTTPException(400, f"着法格式无效: {uci}")
    if mv not in board.legal_moves:
        raise HTTPException(400, f"非法着法: {uci}")
    mover = board.turn
    san = board.san(mv)
    check = board.gives_check(mv)
    capture = board.is_capture(mv)
    board.push(mv)
    over, result, reason = analysis.game_status(board)
    return {
        "san": san,
        "uci": uci,
        "fen_after": board.fen(),
        "color": "w" if mover == chess.WHITE else "b",
        "capture": capture,
        "check": check,
        "over": over,
        "result": result,
        "reason": reason,
        "check_now_sq": chess.square_name(board.king(board.turn)) if board.is_check() else None,
    }


# ----------------------------- 引擎分析接口 -----------------------------

@app.post("/api/position/analyze")
def position_analyze(req: AnalyzeIn):
    try:
        board = chess.Board(req.fen)
    except ValueError as e:
        raise HTTPException(400, f"无效 FEN: {e}")

    def job(engine):
        limit = chess.engine.Limit(depth=req.depth, time=req.cap)
        infos = engine.analyse(board, limit, multipv=max(1, req.multipv))
        if isinstance(infos, dict):
            infos = [infos]
        lines = []
        for info in infos:
            pv = info.get("pv") or []
            pv_board = board.copy(stack=False)
            pv_san = []
            for mv in pv[:8]:
                pv_san.append(pv_board.san(mv))
                pv_board.push(mv)
            cp_pov = analysis.score_to_cp(info["score"], board.turn)
            lines.append({
                "cp_white": analysis.cp_white_pov(cp_pov, board.turn),
                "cp_pov": cp_pov,
                "mate": None,
                "depth": info.get("depth", 0),
                "nodes": info.get("nodes", 0),
                "pv_san": pv_san,
                "pv_uci": [m.uci() for m in pv[:8]],
            })
        return lines

    lines = run_with_engine(job)
    return {"fen": req.fen, "lines": lines, "turn": "w" if board.turn == chess.WHITE else "b"}


@app.post("/api/engine/move")
def engine_move(req: EngineMoveIn):
    try:
        board = chess.Board(req.fen)
    except ValueError as e:
        raise HTTPException(400, f"无效 FEN: {e}")
    if board.is_game_over():
        raise HTTPException(400, "对局已结束")
    levels = {1: (3, 0.15), 2: (8, 0.4), 3: (13, 0.8), 4: (20, 1.5)}
    skill, movetime = levels.get(max(1, min(4, req.level)), (8, 0.4))

    def job(engine):
        engine.configure({"Skill Level": skill})
        try:
            return engine.play(board, chess.engine.Limit(time=movetime))
        finally:
            engine.configure({"Skill Level": 20})

    result = run_with_engine(job)
    mv = result.move
    if mv is None:
        raise HTTPException(500, "引擎未能返回着法")
    mover = board.turn
    san = board.san(mv)
    gives_check = board.gives_check(mv)
    is_capture = board.is_capture(mv)
    board.push(mv)
    over, res, reason = analysis.game_status(board)
    return {
        "san": san,
        "uci": mv.uci(),
        "fen_after": board.fen(),
        "color": "w" if mover == chess.WHITE else "b",
        "capture": is_capture,
        "check": gives_check,
        "over": over,
        "result": res,
        "reason": reason,
    }


# ----------------------------- PGN / 任务 -----------------------------

@app.post("/api/games/parse")
def games_parse(req: ParsePgnIn):
    if not req.pgn.strip():
        raise HTTPException(400, "PGN 内容为空")
    return analysis.parse_pgn(req.pgn)


# 后台分析任务注册表
_jobs: dict = {}
_jobs_lock = threading.Lock()


def _get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "任务不存在")
    return job


@app.post("/api/games/analyze-job")
def games_analyze_job(req: AnalyzeJobIn):
    try:
        chess.Board(req.initial_fen)
    except ValueError as e:
        raise HTTPException(400, f"无效 FEN: {e}")
    job_id = uuid.uuid4().hex[:12]
    job = {"status": "running", "done": 0, "total": len(req.moves) + 1,
           "result": None, "error": None, "cancel": False}
    with _jobs_lock:
        _jobs[job_id] = job

    def worker():
        def progress(done, total):
            job["done"], job["total"] = done, total
        try:
            def run(engine):
                return analysis.analyse_game(
                    engine, req.initial_fen, req.moves,
                    depth=req.depth, cap_seconds=req.cap,
                    progress=progress,
                    should_cancel=lambda: job["cancel"],
                )
            res = run_with_engine(run)
            job["result"] = res
            job["status"] = "cancelled" if res.get("cancelled") else "done"
        except Exception as e:
            job["error"] = str(e)
            job["status"] = "error"

    threading.Thread(target=worker, daemon=True, name=f"analyze-{job_id}").start()
    return {"job_id": job_id, "total": job["total"]}


@app.get("/api/jobs/{job_id}")
def jobs_get(job_id: str):
    job = _get_job(job_id)
    out = {k: job[k] for k in ("status", "done", "total", "error")}
    out["result"] = job["result"]
    return out


@app.post("/api/jobs/{job_id}/cancel")
def jobs_cancel(job_id: str):
    job = _get_job(job_id)
    job["cancel"] = True
    return {"ok": True}


@app.post("/api/games/export")
def games_export(req: ExportIn):
    try:
        text = analysis.export_pgn(
            req.headers, req.initial_fen, req.moves,
            req.analysis, engine_manager.engine_name(),
        )
    except Exception as e:
        raise HTTPException(400, f"导出失败: {e}")
    return {"pgn": text}


# 静态资源
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
