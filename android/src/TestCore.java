import stfchess.core.ChessCore;
import stfchess.core.UciEngine;
import org.json.JSONObject;
import org.json.JSONArray;
import java.util.Arrays;
import java.util.Collections;

public class TestCore {
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) throws Exception {
        check(ChessCore.positionMoves(ChessCore.START_FEN).getJSONArray("moves").length() == 20, "opening legal moves");
        check(ChessCore.cpToDisplay(99997).equals("#3"), "mate distance");
        check(ChessCore.cpToDisplay(-99999).equals("#-1"), "black mate distance");
        java.util.Locale previous = java.util.Locale.getDefault();
        java.util.Locale.setDefault(java.util.Locale.GERMANY);
        check(ChessCore.cpToDisplay(80).equals("+0.80"), "locale-independent PGN scores");
        java.util.Locale.setDefault(previous);

        String black = ChessCore.START_FEN.replace(" w ", " b ").replace("0 1", "0 7");
        JSONObject parsed = ChessCore.parsePgn("[SetUp \"1\"]\n[FEN \"" + black + "\"]\n\n7... e5 8. e4 *");
        check(parsed.getJSONArray("moves").getJSONObject(0).getString("color").equals("b"), "black-start PGN color");
        JSONArray annotations = new JSONArray().put(new JSONObject().put("cls", "mistake").put("eval_white_after", 125));
        String pgn = ChessCore.exportPgn(new JSONObject(), black, Arrays.asList("e7e5"), annotations, "Stockfish");
        check(pgn.contains("[%eval +1.25]"), "machine-readable eval annotation");
        check(ChessCore.parsePgn(pgn).getString("initial_fen").equals(black), "custom FEN export round trip");
        check(ChessCore.parsePgn("1. e4 (1. d4 d5 (1... Nf6)) e5 *")
                .getJSONArray("moves").length() == 2, "nested variations excluded from mainline");
        check(ChessCore.parsePgn("1. e4 {ignore (brackets)} e5 ; ignore variation (\n2. Nf3 *")
                .getJSONArray("moves").length() == 3, "PGN comments do not alter variation depth");
        check(ChessCore.parsePgn("1. e4 e5 *\n1. d4 d5 *")
                .getJSONArray("moves").length() == 2, "only the first game is imported");
        for (String invalid : Arrays.asList("8/8/8/8/8/8/8/8 w - - 0 1",
                "7k/8/8/8/8/8/8/K6P w - - 0 1", "not a fen")) {
            boolean rejected = false;
            try { ChessCore.positionMoves(invalid); }
            catch (IllegalArgumentException expected) { rejected = true; }
            check(rejected, "invalid FEN rejected before move generation");
        }

        String mate = "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1";
        check(ChessCore.positionMoves(mate).getBoolean("over"), "terminal position status");
        check(ChessCore.analyze(mate, 8, 3, .1, null).getJSONArray("lines").getJSONObject(0).getInt("cp_white") == 100000, "terminal score without engine");
        check(ChessCore.applyUci("7k/P7/8/8/8/8/8/6K1 w - - 0 1", "a7a8n").getString("san").equals("a8=N"), "underpromotion");

        UciEngine scripted = new UciEngine() {
            public java.util.List<Line> analyse(String fen, int depth, int ms, int pv) {
                Line line = new Line();
                line.cpPov = fen.split(" ")[1].equals("w") ? 80 : -80;
                return Collections.singletonList(line);
            }
        };
        JSONObject report = ChessCore.analyzeGame(black, Arrays.asList("e7e5"), 8, .1, scripted, new ChessCore.JobCtl() {
            public void progress(int done, int total) {}
            public boolean cancelled() { return false; }
        });
        check(report.getJSONArray("moves").getJSONObject(0).getString("best_score").equals("+0.80"), "white-perspective scores");
        System.out.println("Android core regression checks passed");
    }
}
