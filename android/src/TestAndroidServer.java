import stfchess.core.ChessCore;
import stfchess.core.ChessServer;
import stfchess.core.UciEngine;
import org.json.JSONObject;
import org.json.JSONArray;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipFile;

/** Runs the Android Java backend against the assets in the actual APK on a host JVM.
 * This checks the Android protocol and packaged assets, not Android installation/WebView. */
public class TestAndroidServer {
    private static String base;
    private static int passed;
    private static int failed;
    interface Check { void run() throws Exception; }
    private static void test(String name, Check check) {
        try { check.run(); passed++; System.out.println("PASS " + name); }
        catch (Exception | AssertionError e) { failed++; System.out.println("FAIL " + name + ": " + e); }
    }
    private static void expect(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static String request(String path, JSONObject body, int expected) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setConnectTimeout(3000);
        connection.setReadTimeout(8000);
        try {
            if (body != null) {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                try (java.io.OutputStream out = connection.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = connection.getResponseCode();
            String text;
            try (java.io.InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            expect(status == expected, "HTTP " + status + " " + text);
            return text;
        } finally { connection.disconnect(); }
    }
    private static JSONObject post(String path, JSONObject body) throws Exception {
        return new JSONObject(request(path, body, 200));
    }
    private static JSONObject position() { return new JSONObject().put("fen", ChessCore.START_FEN); }
    private static JSONObject waitJob(String id) throws Exception {
        for (int n = 0; n < 100; n++) {
            JSONObject job = new JSONObject(request("/api/jobs/" + id, null, 200));
            if (!job.getString("status").equals("running")) return job;
            Thread.sleep(50);
        }
        throw new AssertionError("job timeout");
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("TestAndroidServer <APK> <host Stockfish>");
        UciEngine engine = new UciEngine();
        ChessServer server = null;
        try (ZipFile apk = new ZipFile(args[0])) {
            engine.start(args[1]);
            server = new ChessServer(0, path -> {
                java.util.zip.ZipEntry entry = apk.getEntry("assets/www/" + path);
                if (entry == null) return null;
                try (java.io.InputStream in = apk.getInputStream(entry)) { return in.readAllBytes(); }
            }, engine);
            base = "http://127.0.0.1:" + server.getListeningPort();
            test("packaged home", () -> expect(request("/", null, 200).contains("棋局研究室"), "old UI"));
            test("packaged CSS and JS", () -> {
                expect(request("/static/style.css", null, 200).contains(".modal"), "CSS missing");
                expect(request("/static/app.js", null, 200).contains("positionGen"), "JS missing");
            });
            test("engine health", () -> expect(new JSONObject(request("/api/health", null, 200)).getString("engine").contains("Stockfish"), "engine missing"));
            test("20 opening moves", () -> expect(post("/api/position/moves", position()).getJSONArray("moves").length() == 20, "wrong legal moves"));
            test("user move", () -> expect(post("/api/position/move", position().put("from", "e2").put("to", "e4")).getString("san").equals("e4"), "wrong move"));
            test("three engine variations", () -> expect(post("/api/position/analyze", position().put("depth", 8).put("cap", .2).put("multipv", 3)).getJSONArray("lines").length() == 3, "missing variations"));
            test("engine response", () -> expect(!post("/api/engine/move", position().put("level", 1)).getString("uci").isEmpty(), "no engine move"));
            test("terminal position", () -> expect(post("/api/position/moves", new JSONObject().put("fen", "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1")).getBoolean("over"), "mate not recognized"));
            test("PGN import", () -> expect(post("/api/games/parse", new JSONObject().put("pgn", "1. e4 e5 2. Nf3 Nc6 *")).getJSONArray("moves").length() == 4, "PGN truncated"));
            test("PGN with nested variations", () -> expect(post("/api/games/parse", new JSONObject().put("pgn", "1. e4 (1. d4 d5 (1... Nf6)) e5 *")).getJSONArray("moves").length() == 2, "variation mixed into mainline"));
            test("invalid FEN is a client error", () -> request("/api/position/moves", new JSONObject().put("fen", "8/8/8/8/8/8/8/8 w - - 0 1"), 400));
            test("full-game report", () -> {
                String id = post("/api/games/analyze-job", new JSONObject().put("initial_fen", ChessCore.START_FEN).put("moves", new JSONArray().put("e2e4").put("e7e5")).put("depth", 8).put("cap", .1)).getString("job_id");
                JSONObject job = waitJob(id);
                expect(job.getString("status").equals("done"), job.toString());
                expect(job.getJSONObject("result").getJSONArray("moves").length() == 2, "report missing moves");
            });
            test("cancel analysis", () -> {
                String id = post("/api/games/analyze-job", new JSONObject().put("moves", new JSONArray().put("e2e4").put("e7e5")).put("depth", 25).put("cap", 1)).getString("job_id");
                post("/api/jobs/" + id + "/cancel", new JSONObject());
                JSONObject job = waitJob(id);
                expect(job.getString("status").equals("cancelled"), job.toString());
            });
            System.out.println("Android backend integration: " + passed + " passed, " + failed + " failed");
        } finally {
            if (server != null) server.stop();
            engine.quit();
        }
        if (failed > 0) throw new AssertionError("Android integration failures: " + failed);
    }
}
