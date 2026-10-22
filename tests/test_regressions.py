import io
import unittest
from unittest.mock import patch

import chess
import chess.engine
import chess.pgn
from fastapi.testclient import TestClient

import analysis
from server import app


BLACK_START = chess.STARTING_FEN.replace(" w ", " b ").replace("0 1", "0 7")
MATE = "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"
DRAW = "7k/8/6K1/8/8/8/8/8 w - - 0 1"


class AnalysisRegressions(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_mate_distance_has_no_extra_move(self):
        for distance in [1, 3, -1, -3, 0]:
            cp = chess.engine.Mate(distance).score(mate_score=analysis.MATE_CP)
            expected = f"#{distance}" if distance > 0 else f"#-{abs(distance)}"
            self.assertEqual(analysis.cp_to_display(cp), expected)

    def test_black_start_pgn_keeps_color_and_fullmove(self):
        parsed = analysis.parse_pgn(f'[SetUp "1"]\n[FEN "{BLACK_START}"]\n\n7... e5 8. e4 *')
        self.assertEqual(parsed["initial_fen"], BLACK_START)
        self.assertEqual([m["color"] for m in parsed["moves"]], ["b", "w"])

    def test_fen_header_without_setup_uses_actual_initial_board(self):
        parsed = analysis.parse_pgn(f'[FEN "{BLACK_START}"]\n\n7... e5 *')
        self.assertEqual(parsed["initial_fen"], BLACK_START)

    def test_partial_illegal_pgn_returns_400_instead_of_silent_truncation(self):
        response = self.client.post("/api/games/parse", json={"pgn": "1. e4 e5 2. Bh6 *"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("PGN", response.json()["detail"])

    def test_invalid_fen_is_rejected_by_every_position_endpoint(self):
        fen = "8/8/8/8/8/8/8/8 w - - 0 1"
        requests = [("moves", {}), ("move", {"from": "a1", "to": "a2"}), ("analyze", {})]
        for endpoint, data in requests:
            response = self.client.post(f"/api/position/{endpoint}", json={"fen": fen, **data})
            self.assertEqual(response.status_code, 400, endpoint)

    def test_checkmate_and_draw_analysis_do_not_require_engine(self):
        with patch("engine_manager.get_engine", side_effect=AssertionError("must not start engine")):
            for fen, expected in [(MATE, 100000), (DRAW, 0)]:
                response = self.client.post("/api/position/analyze", json={"fen": fen})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["lines"][0]["cp_white"], expected)
                moves = self.client.post("/api/position/moves", json={"fen": fen}).json()
                self.assertTrue(moves["over"])

    def test_export_eval_is_machine_readable_and_preserves_fen(self):
        text = analysis.export_pgn({}, BLACK_START, ["e7e5"], [{
            "cls": "mistake", "eval_white_after": 125, "cp_loss": 80,
        }])
        game = chess.pgn.read_game(io.StringIO(text))
        self.assertEqual(game.board().fen(), BLACK_START)
        self.assertEqual(game.end().eval().white().score(), 125)
        self.assertIn("错误", game.end().comment)

    def test_best_and_played_scores_use_same_white_perspective(self):
        class Engine:
            def analyse(self, board, *args, **kwargs):
                return [{"score": chess.engine.PovScore(chess.engine.Cp(80), chess.WHITE),
                         "pv": [next(iter(board.legal_moves))], "depth": 8}]
        result = analysis.analyse_game(Engine(), BLACK_START, ["e7e5"])
        self.assertEqual(result["moves"][0]["best_score"], "+0.80")
        self.assertEqual(result["moves"][0]["played_score"], "+0.80")

    def test_analysis_parameters_are_bounded(self):
        for data in [{"cap": -1}, {"depth": 0}, {"multipv": 999}]:
            response = self.client.post("/api/position/analyze", json={"fen": chess.STARTING_FEN, **data})
            self.assertEqual(response.status_code, 422)

    def test_missing_engine_returns_actionable_503(self):
        from engine_manager import EngineError
        with patch("engine_manager.get_engine", side_effect=EngineError("请下载引擎")):
            response = self.client.post("/api/position/analyze", json={"fen": chess.STARTING_FEN})
        self.assertEqual(response.status_code, 503)
        self.assertIn("下载引擎", response.json()["detail"])

    def test_promotion_castling_and_en_passant(self):
        for fen, source, target, promotion, san in [
            ("7k/P7/8/8/8/8/8/6K1 w - - 0 1", "a7", "a8", "n", "a8=N"),
            ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1", "g1", None, "O-O"),
            ("7k/8/8/3pP3/8/8/8/6K1 w - d6 0 1", "e5", "d6", None, "exd6"),
        ]:
            response = self.client.post("/api/position/move", json={"fen": fen, "from": source, "to": target, "promotion": promotion})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["san"], san)


if __name__ == "__main__":
    unittest.main()
