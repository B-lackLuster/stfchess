package stfchess.core;

import fi.iki.elonen.NanoHTTPD;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 内置 HTTP 服务：静态前端 + 与 Python 版完全同构的 /api 接口。 */
public class ChessServer extends NanoHTTPD {

    /** 静态资源来源：桌面=文件系统，安卓=AssetManager。返回 null 表示不存在。 */
    public interface Assets {
        byte[] get(String path) throws IOException;
    }

    private final Assets assets;
    private final UciEngine engine;
    private final Map<String, JSONObject> jobs = new ConcurrentHashMap<>();

    public ChessServer(int port, Assets assets, UciEngine engine) throws IOException {
        super("127.0.0.1", port); // 只给本机 WebView 用，不对局域网开放
        this.assets = assets;
        this.engine = engine;
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
    }

    private static Response json(JSONObject o) {
        byte[] b = o.toString().getBytes(StandardCharsets.UTF_8);
        Response r = newFixedLengthResponse(Response.Status.OK, "application/json",
                new ByteArrayInputStream(b), b.length);
        r.addHeader("Cache-Control", "no-store");
        return r;
    }

    private static Response jsonError(int status, String msg) {
        byte[] b = new JSONObject().put("detail", msg).toString().getBytes(StandardCharsets.UTF_8);
        return newFixedLengthResponse(Response.Status.lookup(status), "application/json",
                new ByteArrayInputStream(b), b.length);
    }

    private static Response text(String s, String mime) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        return newFixedLengthResponse(Response.Status.OK, mime,
                new ByteArrayInputStream(b), b.length);
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        try {
            if (uri.startsWith("/api/")) return api(session, uri);
            return staticFile(uri);
        } catch (IllegalArgumentException e) {
            return jsonError(400, e.getMessage() == null ? "请求无效" : e.getMessage());
        } catch (IllegalStateException e) {
            return jsonError(503, e.getMessage() == null ? "引擎不可用" : e.getMessage());
        } catch (Exception e) {
            return jsonError(500, String.valueOf(e.getMessage()));
        }
    }

    private Response staticFile(String uri) throws IOException {
        String path = uri.equals("/") ? "index.html" : uri.substring(1);
        if (!path.startsWith("static/") && !path.equals("index.html")
                && !path.equals("favicon.ico")) path = "index.html";
        byte[] data = assets.get(path);
        if (data == null) return jsonError(404, "未找到: " + path);
        return newFixedLengthResponse(Response.Status.OK, mimeOf(path),
                new ByteArrayInputStream(data), data.length);
    }

    private static String mimeOf(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".ico")) return "image/x-icon";
        if (path.endsWith(".pgn")) return "application/x-chess-pgn";
        return "application/octet-stream";
    }

    private Response api(IHTTPSession session, String uri) throws Exception {
        JSONObject body = new JSONObject();
        if (session.getMethod() == Method.POST) {
            Map<String, String> files = new HashMap<>();
            session.parseBody(files);
            String raw = files.get("postData");
            if (raw != null && !raw.trim().isEmpty()) body = new JSONObject(raw);
        }
        switch (uri) {
            case "/api/health": return health();
            case "/api/position/moves": return positionMoves(body);
            case "/api/position/move": return positionMove(body);
            case "/api/position/analyze": return analyze(body);
            case "/api/engine/move": return engineMove(body);
            case "/api/games/parse": return gamesParse(body);
            case "/api/games/analyze-job": return analyzeJob(body);
            case "/api/games/export": return gamesExport(body);
            default:
                if (uri.startsWith("/api/jobs/")) {
                    String rest = uri.substring("/api/jobs/".length());
                    if (rest.endsWith("/cancel")) return jobCancel(rest.substring(0, rest.length() - 7));
                    return jobGet(rest);
                }
                return jsonError(404, "未知接口: " + uri);
        }
    }

    private Response health() {
        JSONObject o = new JSONObject();
        o.put("engine", engine.getName());
        o.put("threads", Runtime.getRuntime().availableProcessors());
        return json(o);
    }

    private Response positionMoves(JSONObject body) throws Exception {
        return json(ChessCore.positionMoves(body.getString("fen")));
    }

    private Response positionMove(JSONObject body) throws Exception {
        // Android 自带 org.json 的 optString 会把 JSON null 返回成字符串 "null"，需清洗
        String promo = body.optString("promotion", "");
        if (promo == null || promo.equals("null") || promo.length() != 1
                || !"qrbn".contains(promo)) promo = "";
        String uci = body.getString("from") + body.getString("to") + promo;
        if (!uci.matches("[a-h][1-8][a-h][1-8][qrbn]?")) {
            throw new IllegalArgumentException("着法格式无效: " + uci);
        }
        return json(ChessCore.applyUci(body.getString("fen"), uci));
    }

    private Response analyze(JSONObject body) throws Exception {
        return json(ChessCore.analyze(body.getString("fen"), body.optInt("depth", 12),
                body.optInt("multipv", 3), body.optDouble("cap", 2.5), engine));
    }

    private Response engineMove(JSONObject body) throws Exception {
        return json(ChessCore.engineMove(body.getString("fen"), body.optInt("level", 2), engine));
    }

    private Response gamesParse(JSONObject body) throws Exception {
        String pgn = body.getString("pgn");
        if (pgn.trim().isEmpty()) throw new IllegalArgumentException("PGN 内容为空");
        return json(ChessCore.parsePgn(pgn));
    }

    private Response gamesExport(JSONObject body) throws Exception {
        List<String> moves = new java.util.ArrayList<>();
        JSONArray ma = body.getJSONArray("moves");
        for (int i = 0; i < ma.length(); i++) moves.add(ma.getString(i));
        JSONObject headers = body.optJSONObject("headers");
        String pgn = ChessCore.exportPgn(headers, body.optString("initial_fen", ChessCore.START_FEN),
                moves, body.optJSONArray("analysis"), engine.getName());
        return json(new JSONObject().put("pgn", pgn));
    }

    private Response analyzeJob(JSONObject body) throws Exception {
        List<String> moves = new java.util.ArrayList<>();
        JSONArray ma = body.getJSONArray("moves");
        for (int i = 0; i < ma.length(); i++) moves.add(ma.getString(i));
        String id = UUID.randomUUID().toString().substring(0, 12);
        JSONObject job = new JSONObject();
        job.put("status", "running");
        job.put("done", 0);
        job.put("total", moves.size() + 1);
        job.put("error", JSONObject.NULL);
        job.put("cancel", false);
        job.put("result", JSONObject.NULL);
        jobs.put(id, job);
        final String initialFen = body.optString("initial_fen", ChessCore.START_FEN);
        final int depth = body.optInt("depth", 12);
        final double cap = body.optDouble("cap", 2.0);
        new Thread(() -> {
            try {
                JSONObject res = ChessCore.analyzeGame(initialFen, moves, depth, cap, engine,
                        new ChessCore.JobCtl() {
                            public void progress(int done, int total) {
                                synchronized (job) {
                                    job.put("done", done);
                                    job.put("total", total);
                                }
                            }

                            public boolean cancelled() {
                                return job.optBoolean("cancel", false);
                            }
                        });
                synchronized (job) {
                    job.put("result", res);
                    job.put("status", res.optBoolean("cancelled") ? "cancelled" : "done");
                }
            } catch (Exception e) {
                synchronized (job) {
                    job.put("error", String.valueOf(e.getMessage()));
                    job.put("status", "error");
                }
            }
        }, "analyze-" + id).start();
        JSONObject out = new JSONObject();
        out.put("job_id", id);
        out.put("total", job.getInt("total"));
        return json(out);
    }

    private Response jobGet(String id) {
        JSONObject job = jobs.get(id);
        if (job == null) return jsonError(404, "任务不存在");
        synchronized (job) {
            JSONObject out = new JSONObject();
            out.put("status", job.getString("status"));
            out.put("done", job.getInt("done"));
            out.put("total", job.getInt("total"));
            out.put("error", job.get("error"));
            out.put("result", job.get("result"));
            return json(out);
        }
    }

    private Response jobCancel(String id) {
        JSONObject job = jobs.get(id);
        if (job == null) return jsonError(404, "任务不存在");
        job.put("cancel", true);
        return json(new JSONObject().put("ok", true));
    }
}
