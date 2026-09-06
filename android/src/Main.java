import stfchess.core.ChessServer;
import stfchess.core.UciEngine;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/** 桌面 JVM 预测试入口：与安卓同一套核心代码，从磁盘读前端、用 Windows 引擎。 */
public class Main {
    public static void main(String[] args) throws Exception {
        Path root = Paths.get("").toAbsolutePath().getParent() != null
                ? Paths.get("").toAbsolutePath() : Paths.get(".");
        // 用法: java Main <项目根目录> <引擎路径>
        Path base = Paths.get(args.length > 0 ? args[0] : ".");
        String enginePath = args.length > 1 ? args[1]
                : base.resolve("engines/avx2/stockfish/stockfish-windows-x86-64-avx2.exe").toString();

        UciEngine engine = new UciEngine();
        engine.start(enginePath);
        System.out.println("engine: " + engine.getName());

        ChessServer.Assets assets = path -> {
            Path p;
            if (path.startsWith("static/")) {
                p = base.resolve("static").resolve(path.substring("static/".length())).normalize();
            } else {
                p = base.resolve(path).normalize();
            }
            if (!Files.exists(p)) return null;
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            try (FileInputStream in = new FileInputStream(p.toFile())) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            }
            return bos.toByteArray();
        };

        int port = 8177;
        ChessServer server = new ChessServer(port, assets, engine);
        System.out.println("serving http://127.0.0.1:" + port + "/");
        Thread.currentThread().join(); // 常驻
    }
}
