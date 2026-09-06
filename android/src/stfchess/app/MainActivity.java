package stfchess.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.ServerSocket;

import stfchess.core.ChessServer;
import stfchess.core.UciEngine;

/** stfchess 安卓壳：内置 HTTP 服务 + WebView，装上即用、完全离线。 */
public class MainActivity extends Activity {

    private WebView web;
    private ChessServer server;
    private UciEngine engine;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        engine = new UciEngine();
        try {
            File engineFile = new File(getApplicationInfo().nativeLibraryDir, "libstockfish.so");
            engine.start(engineFile.getAbsolutePath());
        } catch (Exception e) {
            throw new RuntimeException("引擎启动失败: " + e, e);
        }

        int port = findFreePort(8765);
        try {
            server = new ChessServer(port, path -> readAsset("www/" + path), engine);
        } catch (IOException e) {
            throw new RuntimeException("服务器启动失败: " + e, e);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        setContentView(web);
        web.loadUrl("http://127.0.0.1:" + port + "/");
    }

    private static int findFreePort(int start) {
        for (int p = start; p < start + 20; p++) {
            try (ServerSocket ss = new ServerSocket(p)) {
                return p;
            } catch (IOException ignored) { }
        }
        return start;
    }

    private byte[] readAsset(String path) throws IOException {
        InputStream in = getAssets().open(path);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return bos.toByteArray();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (engine != null) engine.quit();
        super.onDestroy();
    }
}
