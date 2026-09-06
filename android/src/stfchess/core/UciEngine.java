package stfchess.core;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Stockfish UCI 引擎封装：进程管理、分析、走子。线程安全（内部锁串行化）。 */
public class UciEngine {

    /** 一次分析结果中的一条变着（引擎视角评分）。 */
    public static class Line {
        public int cpPov;        // 行棋方视角厘兵（杀棋按距离折算大数值）
        public int cpWhite;      // 白方视角
        public int depth;
        public long nodes;
        public final List<String> pvUci = new ArrayList<>();
    }

    private static final int MATE_CP = 100_000;

    private Process process;
    private BufferedReader reader;
    private OutputStreamWriter writer;
    private String name = "Stockfish";
    private int curMultiPv = -1;
    private final Object lock = new Object();

    public void start(String enginePath) throws Exception {
        synchronized (lock) {
            ProcessBuilder pb = new ProcessBuilder(new File(enginePath).getAbsolutePath());
            pb.redirectErrorStream(true);
            process = pb.start();
            reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            writer = new OutputStreamWriter(process.getOutputStream());
            send("uci");
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("id name ")) name = line.substring(8).trim();
                if (line.startsWith("uciok")) break;
            }
            // 手机场景：一半核心 + 适度哈希（避免内存压力）
            int threads = Math.max(1, Runtime.getRuntime().availableProcessors() / 2);
            send("setoption name Threads value " + threads);
            send("setoption name Hash value 128");
            send("isready");
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("readyok")) break;
            }
        }
    }

    public String getName() { return name; }

    public boolean isAlive() {
        Process p = process;
        return p != null && p.isAlive();
    }

    public void quit() {
        synchronized (lock) {
            try { send("quit"); } catch (Exception ignored) { }
            if (process != null) process.destroy();
            process = null;
        }
    }

    private void send(String cmd) throws Exception {
        writer.write(cmd + "\n");
        writer.flush();
    }

    private void syncReady() throws Exception {
        send("isready");
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.startsWith("readyok")) return;
            if (line.startsWith("bestmove")) return; // 异常保护
        }
        throw new IllegalStateException("引擎无响应");
    }

    /** UCI score mate N → 厘兵（行棋方视角，杀棋折算为接近 MATE_CP 的大数值）。 */
    static int mateToCp(int mate) {
        return mate > 0 ? MATE_CP - mate : -(MATE_CP - Math.abs(mate));
    }

    /** 分析局面。depth 与 movetime 毫秒双限制（先到为准），multipv 条变着。 */
    public List<Line> analyse(String fen, int depth, int movetimeMs, int multipv) throws Exception {
        synchronized (lock) {
            requireAlive();
            if (multipv != curMultiPv) {
                send("setoption name MultiPV value " + multipv);
                curMultiPv = multipv;
            }
            syncReady();
            send("position fen " + fen);
            send("go depth " + depth + " movetime " + movetimeMs);
            Map<Integer, Line> byIndex = new LinkedHashMap<>();
            String best = null;
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("bestmove")) {
                    String[] t = line.split("\\s+");
                    best = t.length > 1 ? t[1] : null;
                    break;
                }
                if (!line.startsWith("info ")) continue;
                parseInfo(line, byIndex);
            }
            List<Line> out = new ArrayList<>();
            for (int i = 1; i <= multipv; i++) {
                Line ln = byIndex.get(i);
                if (ln != null) out.add(ln);
            }
            return out;
        }
    }

    private void parseInfo(String line, Map<Integer, Line> byIndex) {
        String[] t = line.split("\\s+");
        int multipv = 1, depth = 0;
        long nodes = 0;
        Integer cp = null, mate = null;
        List<String> pv = null;
        for (int i = 1; i < t.length; i++) {
            switch (t[i]) {
                case "multipv": multipv = num(t, ++i); break;
                case "depth": depth = num(t, ++i); break;
                case "nodes": nodes = Long.parseLong(t[++i]); break;
                case "score":
                    if (i + 1 < t.length && t[i + 1].equals("cp")) cp = num(t, i + 2);
                    else if (i + 1 < t.length && t[i + 1].equals("mate")) mate = num(t, i + 2);
                    break;
                case "pv":
                    pv = new ArrayList<>();
                    for (int j = i + 1; j < t.length; j++) pv.add(t[j]);
                    i = t.length;
                    break;
                default: break;
            }
        }
        if (cp == null && mate == null) return;
        Line ln = byIndex.get(multipv);
        if (ln == null) { ln = new Line(); byIndex.put(multipv, ln); }
        ln.cpPov = cp != null ? cp : mateToCp(mate);
        ln.depth = depth;
        ln.nodes = nodes;
        if (pv != null && !pv.isEmpty()) {
            ln.pvUci.clear();
            ln.pvUci.addAll(pv);
        }
    }

    /** 引擎走一步。skill: 1入门 2业余 3大师 4特级。返回 bestmove UCI。 */
    public String bestMove(String fen, int skillLevel, int movetimeMs) throws Exception {
        synchronized (lock) {
            requireAlive();
            send("setoption name MultiPV value 1");
            curMultiPv = 1;
            send("setoption name Skill Level value " + skillLevel);
            syncReady();
            send("position fen " + fen);
            send("go movetime " + movetimeMs);
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("bestmove")) {
                    String[] t = line.split("\\s+");
                    return t.length > 1 ? t[1] : null;
                }
            }
            return null;
        }
    }

    private void requireAlive() throws IllegalStateException {
        if (process == null || !process.isAlive()) {
            throw new IllegalStateException("引擎进程未运行");
        }
    }

    private static int num(String[] t, int i) {
        return Integer.parseInt(t[i]);
    }
}
