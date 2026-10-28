import os
import unittest

import chess
from fastapi.testclient import TestClient

import analysis
import engine_manager
from server import app, run_with_engine


@unittest.skipUnless(any(os.path.isfile(p) for p in engine_manager._ENGINE_CANDIDATES),
                     "Run tools/get_engines.py to enable real Stockfish tests")
class StockfishIntegration(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        engine_manager.quit_engine()

    def test_live_multipv_and_engine_move(self):
        client = TestClient(app)
        response = client.post("/api/position/analyze", json={
            "fen": chess.STARTING_FEN, "depth": 8, "cap": .3, "multipv": 3})
        self.assertEqual(response.status_code, 200, response.text)
        lines = response.json()["lines"]
        self.assertEqual(len(lines), 3)
        board = chess.Board()
        for line in lines:
            self.assertIn(chess.Move.from_uci(line["pv_uci"][0]), board.legal_moves)
        move = client.post("/api/engine/move", json={"fen": board.fen(), "level": 1})
        self.assertEqual(move.status_code, 200, move.text)
        self.assertIn(chess.Move.from_uci(move.json()["uci"]), board.legal_moves)

    def test_full_game_ending_in_mate(self):
        result = run_with_engine(lambda engine: analysis.analyse_game(
            engine, chess.STARTING_FEN, ["f2f3", "e7e5", "g2g4", "d8h4"], depth=8, cap_seconds=.2))
        self.assertTrue(result["over"])
        self.assertEqual(result["result"], "0-1")
        self.assertEqual(result["moves"][-1]["played_score"], "#-0")
        self.assertEqual(len(result["moves"]), 4)

    def test_game_analysis_cancels_between_positions(self):
        progress = []
        result = run_with_engine(lambda engine: analysis.analyse_game(
            engine, chess.STARTING_FEN, ["e2e4", "e7e5"], depth=8, cap_seconds=.2,
            progress=lambda done, total: progress.append(done), should_cancel=lambda: bool(progress)))
        self.assertEqual(result, {"cancelled": True})
        self.assertEqual(progress, [1])
