package stfchess.core;

import com.github.bhlangonijr.chesslib.Board;
import com.github.bhlangonijr.chesslib.Piece;
import com.github.bhlangonijr.chesslib.PieceType;
import com.github.bhlangonijr.chesslib.Side;
import com.github.bhlangonijr.chesslib.Square;
import com.github.bhlangonijr.chesslib.move.Move;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 规则核心：合法着法/SAN、走子、局面状态、整局分析、PGN 解析与导出。
 *  纯 Java（chesslib + org.json），便于在桌面 JVM 上先行验证。 */
public class ChessCore {

    public static final int MATE_CP = 100_000;
    public static final String START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    private static final String[] CLASS_ORDER =
            {"best", "excellent", "good", "inaccuracy", "mistake", "blunder"};
    private static final Map<String, String> CLASS_LABEL = new HashMap<>();
    static {
        CLASS_LABEL.put("best", "最佳");
        CLASS_LABEL.put("excellent", "优秀");
        CLASS_LABEL.put("good", "良好");
        CLASS_LABEL.put("inaccuracy", "不精确");
        CLASS_LABEL.put("mistake", "错误");
        CLASS_LABEL.put("blunder", "大错");
    }
    private static final Map<String, Integer> CLASS_NAG = new HashMap<>();
    static {
        CLASS_NAG.put("best", 1);
        CLASS_NAG.put("excellent", 5);
        CLASS_NAG.put("inaccuracy", 6);
        CLASS_NAG.put("mistake", 2);
        CLASS_NAG.put("blunder", 4);
    }

    /* ---------------- 基础工具 ---------------- */

    public static String sq(Square s) {
        return s.value().toLowerCase();
    }

    private static Square sq(String name) {
        return Square.fromValue(name.toUpperCase());
    }

    private static char promoChar(Piece p) {
        return promoChar(p.getPieceType());
    }

    private static Piece promoPiece(char c, Side side) {
        PieceType t = promoType(c);
        if (t == null) return null;
        if (t == PieceType.QUEEN) return side == Side.WHITE ? Piece.WHITE_QUEEN : Piece.BLACK_QUEEN;
        if (t == PieceType.ROOK) return side == Side.WHITE ? Piece.WHITE_ROOK : Piece.BLACK_ROOK;
        if (t == PieceType.BISHOP) return side == Side.WHITE ? Piece.WHITE_BISHOP : Piece.BLACK_BISHOP;
        return side == Side.WHITE ? Piece.WHITE_KNIGHT : Piece.BLACK_KNIGHT;
    }

    private static char promoChar(PieceType t) {
        if (t == PieceType.QUEEN) return 'q';
        if (t == PieceType.ROOK) return 'r';
        if (t == PieceType.BISHOP) return 'b';
        if (t == PieceType.KNIGHT) return 'n';
        return 0;
    }

    private static PieceType promoType(char c) {
        switch (Character.toLowerCase(c)) {
            case 'q': return PieceType.QUEEN;
            case 'r': return PieceType.ROOK;
            case 'b': return PieceType.BISHOP;
            case 'n': return PieceType.KNIGHT;
            default: return null;
        }
    }

    public static String moveUci(Move m) {
        String u = sq(m.getFrom()) + sq(m.getTo());
        if (m.getPromotion() != null && m.getPromotion() != Piece.NONE) {
            u += promoChar(m.getPromotion());
        }
        return u;
    }

    public static Move parseUci(String uci, Board board) {
        Square from = sq(uci.substring(0, 2));
        Square to = sq(uci.substring(2, 4));
        if (uci.length() > 4) {
            Piece promo = promoPiece(uci.charAt(4), board.getSideToMove());
            return new Move(from, to, promo);
        }
        return new Move(from, to);
    }

    private static Piece pieceAt(Board b, Square s) {
        Piece p = b.getPiece(s);
        return p == Piece.NONE ? null : p;
    }

    private static PieceType pieceTypeAt(Board b, Square s) {
        Piece p = b.getPiece(s);
        return p == Piece.NONE ? null : p.getPieceType();
    }

    private static boolean isCapture(Board b, Move m) {
        Piece target = b.getPiece(m.getTo());
        Piece mover = b.getPiece(m.getFrom());
        if (target != Piece.NONE) return target.getPieceSide() != mover.getPieceSide();
        return mover.getPieceType() == PieceType.PAWN
                && !sq(m.getFrom()).substring(0, 1).equals(sq(m.getTo()).substring(0, 1));
    }

    private static String pieceLetter(PieceType t) {
        switch (t) {
            case KNIGHT: return "N";
            case BISHOP: return "B";
            case ROOK: return "R";
            case QUEEN: return "Q";
            case KING: return "K";
            default: return "";
        }
    }

    /** 生成着法的 SAN（含消歧、x、=Q、+/#）。会临时回放检测将军/将杀。 */
    public static String sanOf(Board board, Move mv) {
        PieceType type = pieceTypeAt(board, mv.getFrom());
        boolean capture = isCapture(board, mv);
        String san;
        if (type == PieceType.PAWN) {
            san = (capture ? sq(mv.getFrom()).substring(0, 1) + "x" : "") + sq(mv.getTo());
            if (mv.getPromotion() != Piece.NONE) san += "=" + pieceLetter(mv.getPromotion().getPieceType());
        } else if (type == PieceType.KING
                && Math.abs(mv.getFrom().getFile().ordinal() - mv.getTo().getFile().ordinal()) == 2) {
            san = mv.getTo().getFile().ordinal() > mv.getFrom().getFile().ordinal() ? "O-O" : "O-O-O";
        } else {
            String disamb = "";
            if (type != PieceType.KING) {
                List<Move> others = new ArrayList<>();
                for (Move m : board.legalMoves()) {
                    if (m.getFrom() != mv.getFrom() && m.getTo() == mv.getTo()
                            && pieceTypeAt(board, m.getFrom()) == type) others.add(m);
                }
                if (!others.isEmpty()) {
                    boolean sameFile = false, sameRank = false;
                    for (Move o : others) {
                        if (o.getFrom().getFile() == mv.getFrom().getFile()) sameFile = true;
                        if (o.getFrom().getRank() == mv.getFrom().getRank()) sameRank = true;
                    }
                    if (!sameFile) disamb = sq(mv.getFrom()).substring(0, 1);
                    else if (!sameRank) disamb = sq(mv.getFrom()).substring(1, 2);
                    else disamb = sq(mv.getFrom());
                }
            }
            san = pieceLetter(type) + disamb + (capture ? "x" : "") + sq(mv.getTo());
        }
        Board after = replay(board.getFen(), mv);
        if (after != null) {
            if (after.isMated()) return san + "#";
            if (after.isKingAttacked()) return san + "+";
        }
        return san;
    }

    /** 从 FEN 重建局面并走一步（用于探测后续状态）。 */
    private static Board replay(String fen, Move mv) {
        try {
            Board b = new Board();
            b.loadFromFen(fen);
            b.doMove(mv);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------------- 对局状态 ---------------- */

    private static Square findKing(Board b, Side side) {
        Piece king = side == Side.WHITE ? Piece.WHITE_KING : Piece.BLACK_KING;
        for (Square s : Square.values()) {
            if (b.getPiece(s) == king) return s;
        }
        return null;
    }

    /** [over, result, reason] */
    public static String[] gameStatus(Board b) {
        if (b.isMated()) {
            boolean whiteMated = b.getSideToMove() == Side.WHITE;
            return new String[]{"true", whiteMated ? "0-1" : "1-0",
                    whiteMated ? "白方被将杀" : "黑方被将杀"};
        }
        if (b.isStaleMate()) return new String[]{"true", "1/2-1/2", "逼和（无子可动）"};
        if (b.isInsufficientMaterial()) return new String[]{"true", "1/2-1/2", "子力不足"};
        if (b.isRepetition()) return new String[]{"true", "1/2-1/2", "三次重复局面"};
        if (b.getHalfMoveCounter() != null && b.getHalfMoveCounter() >= 100) return new String[]{"true", "1/2-1/2", "五十回合规则"};
        if (b.isDraw()) return new String[]{"true", "1/2-1/2", "和棋"};
        return new String[]{"false", null, null};
    }

    /* ---------------- API: /api/position/moves ---------------- */

    public static JSONObject positionMoves(String fen) throws Exception {
        Board board = new Board();
        board.loadFromFen(fen);
        JSONArray arr = new JSONArray();
        boolean inCheck = board.isKingAttacked();
        Square kingSq = inCheck ? findKing(board, board.getSideToMove()) : null;
        for (Move m : board.legalMoves()) {
            JSONObject o = new JSONObject();
            o.put("from", sq(m.getFrom()));
            o.put("to", sq(m.getTo()));
            o.put("san", sanOf(board, m));
            o.put("uci", moveUci(m));
            o.put("promotion", m.getPromotion() == Piece.NONE ? JSONObject.NULL
                    : m.getPromotion() == Piece.NONE ? null : String.valueOf(promoChar(m.getPromotion())));
            o.put("capture", isCapture(board, m));
            Board after = replay(fen, m);
            o.put("check", after != null && after.isKingAttacked());
            arr.put(o);
        }
        JSONObject out = new JSONObject();
        out.put("moves", arr);
        out.put("turn", board.getSideToMove() == Side.WHITE ? "w" : "b");
        out.put("check_sq", kingSq == null ? JSONObject.NULL : sq(kingSq));
        return out;
    }

    /* ---------------- API: 走子（/api/position/move 与 /api/engine/move 共用） ---------------- */

    public static JSONObject applyUci(String fen, String uci) throws Exception {
        Board board = new Board();
        board.loadFromFen(fen);
        Move mv = parseUci(uci, board);
        boolean legal = false;
        for (Move m : board.legalMoves()) {
            if (moveUci(m).equals(uci)) { mv = m; legal = true; break; }
        }
        if (!legal) throw new IllegalArgumentException("非法着法: " + uci);
        Side mover = board.getSideToMove();
        String san = sanOf(board, mv);
        boolean capture = isCapture(board, mv);
        board.doMove(mv);
        boolean check = board.isKingAttacked();
        String[] st = gameStatus(board);
        JSONObject out = new JSONObject();
        out.put("san", san);
        out.put("uci", moveUci(mv));
        out.put("fen_after", board.getFen());
        out.put("color", mover == Side.WHITE ? "w" : "b");
        out.put("capture", capture);
        out.put("check", check);
        out.put("over", Boolean.parseBoolean(st[0]));
        out.put("result", st[1] == null ? JSONObject.NULL : st[1]);
        out.put("reason", st[2] == null ? JSONObject.NULL : st[2]);
        return out;
    }

    /** 引擎走子：bestMove → applyUci。 */
    public static JSONObject engineMove(String fen, int level, UciEngine engine) throws Exception {
        int[][] lv = {{3, 150}, {8, 400}, {13, 800}, {20, 1500}};
        int[] cfg = lv[Math.max(1, Math.min(4, level)) - 1];
        String best = engine.bestMove(fen, cfg[0], cfg[1]);
        if (best == null) throw new IllegalStateException("引擎未能返回着法");
        return applyUci(fen, best);
    }

    /* ---------------- 分析数学 ---------------- */

    public static int winPercentCp(int cp) {
        if (cp >= MATE_CP - 1000) return 100;
        if (cp <= -(MATE_CP - 1000)) return 0;
        double wp = 50.0 + 50.0 * (2.0 / (1.0 + Math.exp(-0.00368208 * cp)) - 1.0);
        return (int) Math.round(wp);
    }

    private static double moveAccuracy(double winBefore, double winAfter) {
        double a = 103.1668 * Math.exp(-0.04354 * (winBefore - winAfter)) - 3.1669;
        return Math.max(0.0, Math.min(100.0, a));
    }

    private static String classify(int loss, boolean isBest) {
        if (isBest || loss <= 1) return "best";
        if (loss <= 10) return "excellent";
        if (loss <= 25) return "good";
        if (loss <= 50) return "inaccuracy";
        if (loss <= 100) return "mistake";
        return "blunder";
    }

    public static String cpToDisplay(int cpWhite) {
        if (cpWhite >= MATE_CP - 1000) return "#" + (MATE_CP - cpWhite + 1);
        if (cpWhite <= -(MATE_CP - 1000)) return "#-" + (MATE_CP + cpWhite + 1);
        return String.format("%+.2f", cpWhite / 100.0);
    }

    /** 把 pv（UCI 序列）转成 SAN 序列。 */
    public static List<String> pvToSan(String fen, List<String> pv, int maxLen) {
        List<String> out = new ArrayList<>();
        try {
            Board b = new Board();
            b.loadFromFen(fen);
            for (String u : pv) {
                if (out.size() >= maxLen) break;
                Move mv = parseUci(u, b);
                boolean ok = false;
                for (Move m : b.legalMoves()) {
                    if (moveUci(m).equals(u)) { mv = m; ok = true; break; }
                }
                if (!ok) break;
                String san = sanOf(b, mv);
                out.add(san);
                b.doMove(mv);
            }
        } catch (Exception ignored) { }
        return out;
    }

    /* ---------------- API: /api/position/analyze ---------------- */

    public static JSONObject analyze(String fen, int depth, int multipv, double capSeconds,
                                     UciEngine engine) throws Exception {
        List<UciEngine.Line> lines = engine.analyse(fen, depth, (int) (capSeconds * 1000), multipv);
        boolean whiteToMove = fen.split(" ").length > 1 && fen.split(" ")[1].startsWith("w");
        JSONArray arr = new JSONArray();
        for (UciEngine.Line ln : lines) {
            JSONObject o = new JSONObject();
            o.put("cp_pov", ln.cpPov);
            o.put("cp_white", whiteToMove ? ln.cpPov : -ln.cpPov);
            o.put("depth", ln.depth);
            o.put("nodes", ln.nodes);
            o.put("mate", JSONObject.NULL);
            JSONArray pvSan = new JSONArray();
            JSONArray pvUci = new JSONArray();
            for (String s : pvToSan(fen, ln.pvUci, 8)) pvSan.put(s);
            for (String s : ln.pvUci) pvUci.put(s);
            o.put("pv_san", pvSan);
            o.put("pv_uci", pvUci);
            arr.put(o);
        }
        JSONObject out = new JSONObject();
        out.put("fen", fen);
        out.put("lines", arr);
        out.put("turn", whiteToMove ? "w" : "b");
        return out;
    }

    /* ---------------- API: 整局分析 ---------------- */

    private static Board boardAfter(String initialFen, List<Move> moves, int count) throws Exception {
        Board b = new Board();
        b.loadFromFen(initialFen);
        for (int i = 0; i < count; i++) b.doMove(moves.get(i));
        return b;
    }

    public interface JobCtl {
        void progress(int done, int total);

        boolean cancelled();
    }

    public static JSONObject analyzeGame(String initialFen, List<String> uciMoves, int depth,
                                         double cap, UciEngine engine, JobCtl ctl) throws Exception {
        // 校验着法
        Board check = new Board();
        check.loadFromFen(initialFen);
        List<Move> moves = new ArrayList<>();
        for (int i = 0; i < uciMoves.size(); i++) {
            String u = uciMoves.get(i);
            Move found = null;
            for (Move m : check.legalMoves()) {
                if (moveUci(m).equals(u)) { found = m; break; }
            }
            if (found == null) throw new IllegalArgumentException("第 " + (i + 1) + " 步是非法着法: " + u);
            moves.add(found);
            check.doMove(found);
        }
        int n = moves.size();
        List<UciEngine.Line> pos = new ArrayList<>();
        for (int p = 0; p <= n; p++) {
            if (ctl.cancelled()) {
                JSONObject c = new JSONObject();
                c.put("cancelled", true);
                return c;
            }
            Board b = boardAfter(initialFen, moves, p);
            List<UciEngine.Line> lines = engine.analyse(b.getFen(), depth, (int) (cap * 1000), 1);
            pos.add(lines.isEmpty() ? new UciEngine.Line() : lines.get(0));
            ctl.progress(p + 1, n + 1);
        }

        JSONArray results = new JSONArray();
        double accW = 0, accB = 0;
        int nW = 0, nB = 0;
        Map<String, Integer>[] counts = new Map[2];
        counts[0] = new LinkedHashMap<>();
        counts[1] = new LinkedHashMap<>();
        for (String c : CLASS_ORDER) { counts[0].put(c, 0); counts[1].put(c, 0); }

        for (int i = 0; i < n; i++) {
            Board before = boardAfter(initialFen, moves, i);
            UciEngine.Line best = pos.get(i);
            UciEngine.Line opp = pos.get(i + 1);
            boolean white = before.getSideToMove() == Side.WHITE;
            String playedUci = moveUci(moves.get(i));
            int playedCp = -opp.cpPov;                       // 对手视角取反 → 行棋方实际所得
            int loss = Math.max(0, best.cpPov - playedCp);
            boolean isBest = best.pvUci != null && !best.pvUci.isEmpty()
                    && best.pvUci.get(0).equals(playedUci);
            String cls = classify(loss, isBest);
            double acc = moveAccuracy(winPercentCp(best.cpPov), winPercentCp(playedCp));
            int bestCpWhite = white ? best.cpPov : -best.cpPov;
            int afterCpWhite = white ? -opp.cpPov : opp.cpPov;

            int sideIdx = white ? 0 : 1;
            counts[sideIdx].put(cls, counts[sideIdx].get(cls) + 1);
            if (white) { accW += acc; nW++; } else { accB += acc; nB++; }

            String bestSan = best.pvUci == null || best.pvUci.isEmpty() ? null
                    : pvToSan(before.getFen(), best.pvUci, 1).isEmpty() ? null
                    : pvToSan(before.getFen(), best.pvUci, 1).get(0);
            int moveNumber = Integer.parseInt(before.getFen().split(" ")[5]);

            JSONObject o = new JSONObject();
            o.put("ply", i);
            o.put("san", sanOf(before, moves.get(i)));
            o.put("uci", playedUci);
            o.put("color", white ? "w" : "b");
            o.put("move_number", moveNumber);
            o.put("cp_loss", loss);
            o.put("cls", cls);
            o.put("accuracy", Math.round(acc * 10.0) / 10.0);
            o.put("eval_white_after", afterCpWhite);
            o.put("best_san", bestSan == null ? JSONObject.NULL : bestSan);
            o.put("best_score", cpToDisplay(white ? bestCpWhite : -bestCpWhite));
            o.put("played_score", cpToDisplay(afterCpWhite));
            JSONArray pvSan = new JSONArray();
            List<String> pvs = best.pvUci == null ? new ArrayList<>()
                    : pvToSan(before.getFen(), best.pvUci, 6);
            for (String s : pvs) pvSan.put(s);
            o.put("pv_san", pvSan);
            results.put(o);
        }

        JSONObject countsW = new JSONObject(), countsB = new JSONObject();
        for (String c : CLASS_ORDER) { countsW.put(c, counts[0].get(c)); countsB.put(c, counts[1].get(c)); }

        JSONObject out = new JSONObject();
        out.put("cancelled", false);
        out.put("moves", results);
        Board firstBoard = boardAfter(initialFen, moves, 0);
        boolean whiteStarts = firstBoard.getSideToMove() == Side.WHITE;
        int evalStart = pos.isEmpty() ? 0
                : (whiteStarts ? pos.get(0).cpPov : -pos.get(0).cpPov);
        out.put("eval_start", evalStart);
        out.put("accuracy_white", nW == 0 ? JSONObject.NULL : Math.round(accW / nW * 10.0) / 10.0);
        out.put("accuracy_black", nB == 0 ? JSONObject.NULL : Math.round(accB / nB * 10.0) / 10.0);
        out.put("counts", new JSONObject().put("w", countsW).put("b", countsB));
        Board finalBoard = boardAfter(initialFen, moves, n);
        String[] st = gameStatus(finalBoard);
        out.put("over", Boolean.parseBoolean(st[0]));
        out.put("result", st[1] == null ? JSONObject.NULL : st[1]);
        out.put("result_reason", st[2] == null ? JSONObject.NULL : st[2]);
        return out;
    }

    /* ---------------- PGN 解析与导出 ---------------- */

    /** 解析 PGN：表头用正则提取，着法逐个与生成 SAN 匹配。 */
    public static JSONObject parsePgn(String pgn) throws Exception {
        JSONObject headers = new JSONObject();
        java.util.regex.Matcher hm =
                java.util.regex.Pattern.compile("\\[(\\w+)\\s+\"([^\"]*)\"\\]")
                        .matcher(pgn);
        while (hm.find()) headers.put(hm.group(1), hm.group(2));
        String movetext = pgn.replaceAll("(?m)^\\[.*\\]\\s*$", " ");
        movetext = movetext.replaceAll("\\{[^}]*}", " ")
                .replaceAll(";[^\\n]*", " ")
                .replaceAll("\\$\\d+", " ")
                .replaceAll("\\d+\\s*\\.{1,3}", " ")
                .replaceAll("(1-0|0-1|1/2-1/2|\\*)", " ");
        String initialFen = START_FEN;
        if (headers.has("FEN") && !headers.optString("FEN", "").isEmpty()) {
            initialFen = headers.getString("FEN");
        }
        Board board = new Board();
        board.loadFromFen(initialFen);
        JSONArray moves = new JSONArray();
        for (String tok : movetext.split("\\s+")) {
            String san = tok.trim();
            if (san.isEmpty() || san.equals(".")) continue;
            String norm = san.replaceAll("[+#!?]", "");
            Move found = null;
            String foundSan = null;
            for (Move m : board.legalMoves()) {
                String s2 = sanOf(board, m);
                if (s2.replaceAll("[+#]", "").equals(norm)) { found = m; foundSan = s2; break; }
            }
            if (found == null) throw new IllegalArgumentException("无法解析着法: " + san);
            boolean white = board.getSideToMove() == Side.WHITE;
            boolean capture = isCapture(board, found);
            board.doMove(found);
            JSONObject o = new JSONObject();
            o.put("san", foundSan);
            o.put("uci", moveUci(found));
            o.put("fen_after", board.getFen());
            o.put("capture", capture);
            o.put("check", board.isKingAttacked());
            o.put("color", white ? "w" : "b");
            moves.put(o);
        }
        String[] st = gameStatus(board);
        JSONObject out = new JSONObject();
        out.put("headers", headers);
        out.put("initial_fen", initialFen);
        out.put("moves", moves);
        out.put("over", Boolean.parseBoolean(st[0]));
        out.put("result", headers.optString("Result", "*"));
        return out;
    }

    /** 导出带评注（[%eval]/标签/损失）与 NAG 的 PGN。 */
    public static String exportPgn(JSONObject headers, String initialFen, List<String> uciMoves,
                                   JSONArray analysis, String engineName) throws Exception {
        StringBuilder sb = new StringBuilder();
        java.util.Set<String> skip = new java.util.HashSet<>();
        skip.add("FEN"); skip.add("SetUp");
        if (headers != null && headers.length() > 0) {
            for (String k : headers.keySet()) {
                if (!skip.contains(k)) sb.append("[").append(k).append(" \"")
                        .append(headers.getString(k)).append("\"]").append("\n");
            }
        }
        sb.append("[Annotator \"").append(engineName).append(" 棋局分析\"]\n\n");

        Board board = new Board();
        board.loadFromFen(initialFen);
        boolean white = board.getSideToMove() == Side.WHITE;
        int moveNo = Integer.parseInt(initialFen.split(" ")[5]);
        for (int i = 0; i < uciMoves.size(); i++) {
            Move mv = null;
            String u = uciMoves.get(i);
            for (Move m : board.legalMoves()) {
                if (moveUci(m).equals(u)) { mv = m; break; }
            }
            if (mv == null) break;
            String san = sanOf(board, mv);
            if (white) sb.append(moveNo).append(". ");
            else if (i == 0) sb.append(moveNo).append("... ");
            sb.append(san);
            JSONObject an = analysis != null && i < analysis.length() ? analysis.optJSONObject(i) : null;
            if (an != null && an.has("cls") && !an.isNull("cls")) {
                String cls = an.getString("cls");
                Integer nag = CLASS_NAG.get(cls);
                if (nag != null && nag != 0) sb.append(" $").append(nag);
                StringBuilder cm = new StringBuilder();
                cm.append("%eval ").append(cpToDisplay(an.optInt("eval_white_after", 0)));
                String bestSan = an.optString("best_san", null);
                if (bestSan != null && !bestSan.isEmpty() && !bestSan.equals(an.optString("san", ""))) {
                    cm.append(" 最佳: ").append(bestSan).append(" (")
                            .append(an.optString("best_score", "")).append(")");
                }
                int loss = an.optInt("cp_loss", 0);
                cm.append(loss > 90000 ? " 送杀" : " 损失 " + loss + "厘兵");
                sb.append(" {[").append(CLASS_LABEL.getOrDefault(cls, "")).append(" ")
                        .append(cm).append("]}");
            }
            sb.append(" ");
            board.doMove(mv);
            if (!white) moveNo++;
            white = !white;
        }
        if (headers != null && headers.has("Result")) sb.append(headers.getString("Result"));
        sb.append("\n");
        return sb.toString();
    }
}
