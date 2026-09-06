import stfchess.core.ChessCore;

public class TestCore {
    public static void main(String[] args) throws Exception {
        try {
            System.out.println(ChessCore.positionMoves("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1").toString().substring(0, 400));
        } catch (Throwable t) {
            t.printStackTrace();
        }
    }
}
