"""棋局分析核心：逐步评估、着法分类（最佳/优秀/良好/不精确/错误/大错）、
Lichess 公式准确率、PGN 导出（含评注与 NAG）。
"""
from __future__ import annotations

import io
import math
from typing import Callable, Optional

import chess
import chess.pgn

MATE_CP = 100_000  # 杀棋在数值比较中折算的厘兵值

CLASS_ORDER = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"]
CLASS_LABELS = {
    "best": "最佳",
    "excellent": "优秀",
    "good": "良好",
    "inaccuracy": "不精确",
    "mistake": "错误",
    "blunder": "大错",
}
CLASS_NAG = {
    "best": chess.pgn.NAG_GOOD_MOVE,          # !
    "excellent": chess.pgn.NAG_SPECULATIVE_MOVE,  # !?
    "good": 0,
    "inaccuracy": chess.pgn.NAG_DUBIOUS_MOVE,     # ?!
    "mistake": chess.pgn.NAG_MISTAKE,         # ?
    "blunder": chess.pgn.NAG_BLUNDER,         # ??
}


class ScoreError(ValueError):
    pass


def score_to_cp(score: chess.engine.PovScore, pov: chess.Color) -> int:
    """把引擎评分折算成指定视角的厘兵值（杀棋按距离折算成大数值）。"""
    s = score.pov(pov)
    cp = s.score(mate_score=MATE_CP)
    if cp is None:
        raise ScoreError("引擎未返回评分")
    return cp


def cp_white_pov(cp: int, turn: chess.Color) -> int:
    """mover 视角厘兵值 → 白方视角。"""
    return cp if turn == chess.WHITE else -cp


def cp_to_display(cp_white: int) -> str:
    """白方视角厘兵值 → 展示文本，如 +0.35 / -1.20 / #5 / #-3。"""
    if cp_white >= MATE_CP - 1000:
        return f"#{MATE_CP - cp_white + 1}"
    if cp_white <= -(MATE_CP - 1000):
        return f"#-{MATE_CP + cp_white + 1}"
    return f"{cp_white / 100:+.2f}"


def win_percent(cp: int) -> float:
    """Lichess 胜率公式：厘兵值 → 百分比（视角无关，cp 需为『自己』视角）。"""
    if cp >= MATE_CP - 1000:
        return 100.0
    if cp <= -(MATE_CP - 1000):
        return 0.0
    return 50.0 + 50.0 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def move_accuracy(win_before: float, win_after: float) -> float:
    """Lichess 单步准确率（百分比 0~100）。"""
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * (win_before - win_after)) - 3.1669))


def classify(cp_loss: int, played_is_best: bool) -> str:
    if played_is_best or cp_loss <= 1:
        return "best"
    if cp_loss <= 10:
        return "excellent"
    if cp_loss <= 25:
        return "good"
    if cp_loss <= 50:
        return "inaccuracy"
    if cp_loss <= 100:
        return "mistake"
    return "blunder"


def analyse_position(
    engine: chess.engine.SimpleEngine,
    board: chess.Board,
    depth: int,
    cap_seconds: float,
) -> dict:
    """分析单个局面（当前行棋方视角），返回最佳着法与评分。"""
    limit = chess.engine.Limit(depth=depth, time=cap_seconds)
    info = engine.analyse(board, limit, multipv=1)
    if isinstance(info, list):  # python-chess 在 multipv 模式下返回列表
        info = info[0] if info else {}
    pv = info.get("pv") or []
    best_uci = pv[0].uci() if pv else None
    pv_board = board.copy(stack=False)
    pv_san = []
    for mv in pv[:6]:
        pv_san.append(pv_board.san(mv))
        pv_board.push(mv)
    cp_pov = score_to_cp(info["score"], board.turn)
    return {
        "best_uci": best_uci,
        "best_san": board.san(pv[0]) if pv else None,
        "cp_pov": cp_pov,                                   # 行棋方视角
        "cp_white": cp_white_pov(cp_pov, board.turn),
        "depth": info.get("depth", 0),
        "pv_san": pv_san,
    }


def analyse_game(
    engine: chess.engine.SimpleEngine,
    initial_fen: str,
    uci_moves: list[str],
    depth: int = 12,
    cap_seconds: float = 2.0,
    progress: Optional[Callable[[int, int], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> dict:
    """整局分析：分析 0..N 每个局面一次，导出每步的评分、损失、分类与准确率。

    第 i 步（0 基）:
      best_score  = 局面 i 的引擎评分（行棋方视角）
      played_score = -(局面 i+1 的引擎评分折算回行棋方视角)
      cp_loss = max(0, best - played)
    """
    board = chess.Board(initial_fen)
    # 校验并构建着法序列
    moves = []
    for i, u in enumerate(uci_moves):
        try:
            mv = chess.Move.from_uci(u)
        except ValueError as e:
            raise ScoreError(f"第 {i + 1} 步着法格式无效: {u}") from e
        if mv not in board.legal_moves:
            raise ScoreError(f"第 {i + 1} 步是非法着法: {board.san(mv) if board.is_legal(mv) else u}")
        moves.append(mv)
        board.push(mv)

    n = len(moves)
    pos = []  # 每个局面的分析结果，0..N
    for p in range(n + 1):
        if should_cancel and should_cancel():
            return {"cancelled": True}
        b = chess.Board(initial_fen)
        for mv in moves[:p]:
            b.push(mv)
        pos.append(analyse_position(engine, b, depth, cap_seconds))
        if progress:
            progress(p + 1, n + 1)

    results = []
    acc_white, acc_black = [], []
    counts = {c: {k: 0 for k in CLASS_ORDER} for c in ("w", "b")}
    for i, mv in enumerate(moves):
        b_before = chess.Board(initial_fen)
        for m in moves[:i]:
            b_before.push(m)
        color = b_before.turn          # 行棋方（push 前取）
        move_number = b_before.fullmove_number

        best = pos[i]
        opp = pos[i + 1]
        played_cp = -opp["cp_pov"]            # 对手视角取反 → 行棋方视角
        cp_loss = max(0, best["cp_pov"] - played_cp)
        is_best = best["best_uci"] == mv.uci()
        cls = classify(cp_loss, is_best)
        acc = move_accuracy(win_percent(best["cp_pov"]), win_percent(played_cp))

        key = "w" if color == chess.WHITE else "b"
        (acc_white if color == chess.WHITE else acc_black).append(acc)
        counts[key][cls] += 1

        results.append({
            "ply": i,
            "san": b_before.san(mv),
            "uci": mv.uci(),
            "color": "w" if color == chess.WHITE else "b",
            "move_number": move_number,
            "cp_loss": cp_loss,
            "cls": cls,
            "accuracy": round(acc, 1),
            "eval_white_after": opp["cp_white"],
            "best_san": best["best_san"],
            "best_score": cp_to_display(best["cp_white"] if color == chess.WHITE else -best["cp_white"]),
            "played_score": cp_to_display(opp["cp_white"]),
            "pv_san": best["pv_san"],
        })

    def mean(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    final_board = chess.Board(initial_fen)
    for mv in moves:
        final_board.push(mv)
    over, result, reason = game_status(final_board)

    return {
        "cancelled": False,
        "moves": results,
        "eval_start": pos[0]["cp_white"],
        "accuracy_white": mean(acc_white),
        "accuracy_black": mean(acc_black),
        "counts": counts,
        "result": result,
        "result_reason": reason,
        "over": over,
    }


def game_status(board: chess.Board) -> tuple[bool, Optional[str], Optional[str]]:
    """返回 (是否结束, 结果 1-0/0-1/1/2-1/2, 原因)。"""
    if board.is_checkmate():
        winner = "0-1" if board.turn == chess.WHITE else "1-0"
        loser = "白方" if board.turn == chess.WHITE else "黑方"
        return True, winner, f"{loser}被将杀"
    if board.is_stalemate():
        return True, "1/2-1/2", "逼和（无子可动）"
    if board.is_insufficient_material():
        return True, "1/2-1/2", "子力不足"
    if board.is_fifty_moves():
        return True, "1/2-1/2", "五十回合规则"
    if board.is_repetition(3):
        return True, "1/2-1/2", "三次重复局面"
    if board.is_game_over():
        return True, "1/2-1/2", "和棋"
    return False, None, None


def parse_pgn(text: str) -> dict:
    """解析 PGN 文本，返回头信息与逐步着法。"""
    stream = io.StringIO(text)
    try:
        game = chess.pgn.read_game(stream)
    except Exception as e:
        raise ScoreError(f"PGN 解析失败: {e}") from e
    if game is None:
        raise ScoreError("PGN 为空或格式无效")
    if game.errors:
        # 尽量容忍：只有当主线一条着法都没有时才报错
        first = next(game.mainline_moves(), None)
        if first is None:
            raise ScoreError(f"PGN 解析失败: {game.errors[0]}")

    board = game.board()
    headers = {k: v for k, v in game.headers.items()}
    moves = []
    for mv in game.mainline_moves():
        san = board.san(mv)
        capture = board.is_capture(mv)
        check = board.gives_check(mv)
        board.push(mv)
        moves.append({
            "san": san,
            "uci": mv.uci(),
            "fen_after": board.fen(),
            "capture": capture,
            "check": check,
            "color": "w" if (len(moves) % 2 == 0) else "b",
        })
    fen = game.headers.get("FEN") if game.headers.get("SetUp") == "1" else None
    return {
        "headers": headers,
        "initial_fen": fen or chess.STARTING_FEN,
        "moves": moves,
        "over": board.is_game_over(),
        "result": headers.get("Result", "*"),
    }


def export_pgn(
    headers: dict,
    initial_fen: str,
    uci_moves: list[str],
    analysis_moves: list[dict],
    engine_name: str = "Stockfish",
) -> str:
    """导出带评注（[%eval]、分类标签、损失）与 NAG 的 PGN。"""
    start_board = chess.Board(initial_fen)
    game = chess.pgn.Game()
    if start_board.fen() != chess.STARTING_FEN:
        game.setup(start_board)
    for k, v in (headers or {}).items():
        if k not in ("FEN", "SetUp"):
            game.headers[k] = v
    game.headers["Annotator"] = f"{engine_name} 棋局分析工具"

    node = game
    board = start_board
    for i, u in enumerate(uci_moves):
        mv = chess.Move.from_uci(u)
        node = node.add_main_variation(mv)
        board.push(mv)
        an = analysis_moves[i] if i < len(analysis_moves) else None
        if an and an.get("cls"):
            nag = CLASS_NAG.get(an["cls"], 0)
            if nag:
                node.nags.add(nag)
            parts = [f"%eval {cp_to_display(an.get('eval_white_after', 0))}"]
            if an.get("best_san") and an["best_san"] != an.get("san"):
                parts.append(f"最佳: {an['best_san']} ({an.get('best_score', '')})")
            loss = an.get("cp_loss") or 0
            parts.append("送杀" if loss > 90000 else f"损失 {loss}厘兵")
            cls = CLASS_LABELS.get(an["cls"], "")
            node.comment = f"[{cls} {' '.join(parts)}]"
    return str(game)


def build_moves_for_export(initial_fen: str, uci_moves: list[str]) -> list[dict]:
    """从 uci 序列重建 san 等信息（导出用）。"""
    board = chess.Board(initial_fen)
    out = []
    for u in uci_moves:
        mv = chess.Move.from_uci(u)
        out.append({"san": board.san(mv), "uci": u})
        board.push(mv)
    return out
