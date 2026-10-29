# -*- coding: utf-8 -*-
"""一键构建 stfchess 安卓 APK（无 Gradle，直接用 SDK 工具链）。

前置（Windows 默认放在项目内；也可用 STFCHESS_TOOLCHAIN_ROOT 复用别处的同样结构）:
  tools/jdk/jdk-17.0.20.1+1           JDK
  tools/android/build_tools/android-14  aapt/d8/apksigner/zipalign
  tools/android/android_jar/android-34/android.jar
  tools/android/stockfish/stockfish-android-armv8
  downloads/android/*.jar             chesslib/nanohttpd/commons-lang3/json
macOS / Linux：上面的 JDK、build-tools、android.jar 不存在时，
  改用 JAVA_HOME 与 ANDROID_HOME（需 build-tools;34.0.0 与 platforms;android-34）；
  引擎和 jar 包仍按上面的相对路径放在 STFCHESS_TOOLCHAIN_ROOT 下。
产物: android/stfchess-android.apk
"""
import os
import shutil
import subprocess
import sys

IS_WINDOWS = os.name == "nt"
EXE = ".exe" if IS_WINDOWS else ""
BAT = ".bat" if IS_WINDOWS else ""

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLCHAIN = os.environ.get("STFCHESS_TOOLCHAIN_ROOT", ROOT)
SDK_HOME = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or ""


def _pick(bundled, fallback):
    """优先用工具链目录里的版本（Windows 原有布局），没有时退回系统安装。"""
    return bundled if os.path.exists(bundled) or not fallback else fallback


JDK = _pick(os.path.join(TOOLCHAIN, "tools", "jdk", "jdk-17.0.20.1+1", "bin"),
            os.path.join(os.environ["JAVA_HOME"], "bin") if os.environ.get("JAVA_HOME") else "")
BT = _pick(os.path.join(TOOLCHAIN, "tools", "android", "build_tools", "android-14"),
           os.path.join(SDK_HOME, "build-tools", "34.0.0") if SDK_HOME else "")
AJAR = _pick(os.path.join(TOOLCHAIN, "tools", "android", "android_jar", "android-34", "android.jar"),
             os.path.join(SDK_HOME, "platforms", "android-34", "android.jar") if SDK_HOME else "")
STOCKFISH = os.path.join(TOOLCHAIN, "tools", "android", "stockfish", "stockfish-android-armv8")
SRC = os.path.join(ROOT, "android", "src")
OUT = os.path.join(ROOT, "android", "apk_build")
LIB_JARS = [os.path.join(TOOLCHAIN, "downloads", "android", name)
            for name in ("chesslib.jar", "nanohttpd.jar", "commons-lang3.jar")]
JARS = os.pathsep.join(LIB_JARS)
# 桌面编译时额外需要 org.json（安卓运行时用系统框架自带的）
JSON_JAR = os.path.join(TOOLCHAIN, "downloads", "android", "json.jar")
JARS_COMPILE = JARS + os.pathsep + JSON_JAR
JAVA = os.path.join(JDK, "java" + EXE)
JAVAC = os.path.join(JDK, "javac" + EXE)
KEYTOOL = os.path.join(JDK, "keytool" + EXE)
JAR = os.path.join(JDK, "jar" + EXE)
AAPT = os.path.join(BT, "aapt" + EXE)
ZIPALIGN = os.path.join(BT, "zipalign" + EXE)
APKSIGNER = os.path.join(BT, "apksigner" + BAT)
KEYSTORE = os.path.abspath(os.environ.get("STFCHESS_KEYSTORE", os.path.join(ROOT, "android", "debug.keystore")))


def run(cmd, **kw):
    print(">>", " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd)))
    env = dict(os.environ)
    env["JAVA_HOME"] = os.path.dirname(JDK)
    env["PATH"] = os.path.join(JDK) + os.pathsep + env.get("PATH", "")
    r = subprocess.run(cmd, cwd=OUT, capture_output=True, shell=False, env=env, **kw)
    if r.returncode != 0:
        print((r.stdout or b"")[-3000:].decode("utf-8", "replace"))
        print((r.stderr or b"")[-3000:].decode("gbk" if IS_WINDOWS else "utf-8", "replace"))
        sys.exit("命令失败: " + " ".join(cmd))
    return r


def main():
    required = [JAVAC, AJAR, AAPT, STOCKFISH] + LIB_JARS + [JSON_JAR]
    missing = [path for path in required if not os.path.isfile(path)]
    if missing:
        sys.exit("缺少构建依赖（可设置 STFCHESS_TOOLCHAIN_ROOT 复用已有工具链；"
                 "macOS/Linux 也可设置 JAVA_HOME 与 ANDROID_HOME）:\n" + "\n".join(missing))
    # 兼容旧版构建：在清理中间目录前保留已有签名，之后每次构建复用。
    old_keystore = os.path.join(OUT, "debug.keystore")
    if not os.path.exists(KEYSTORE) and os.path.exists(old_keystore):
        shutil.copy2(old_keystore, KEYSTORE)
    # 0. 清理 + 目录
    if os.path.exists(OUT):
        expected = os.path.normcase(os.path.abspath(os.path.join(ROOT, "android", "apk_build")))
        if os.path.normcase(os.path.realpath(OUT)) != expected or os.path.islink(OUT):
            sys.exit("拒绝清理项目之外的构建目录")
        shutil.rmtree(OUT)
    for d in ["classes", "dex", "assets/www/static", "res/drawable", "lib/arm64-v8a", "apk"]:
        os.makedirs(os.path.join(OUT, d), exist_ok=True)

    # 1. 前端资源 → assets/www（URL /static/x 对应 www/static/x）
    static_src = os.path.join(ROOT, "static")
    www = os.path.join(OUT, "assets", "www")
    shutil.copy(os.path.join(static_src, "index.html"), os.path.join(www, "index.html"))
    for f in ["style.css", "app.js", "icon.png"]:
        src = os.path.join(static_src, f)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(www, "static", f))

    # 2. 安卓资源（启动图标：Android 8+ 自适应图标 + 旧系统 PNG）
    shutil.copytree(os.path.join(ROOT, "android", "res"), os.path.join(OUT, "res"), dirs_exist_ok=True)

    # 3. 引擎二进制 → lib/arm64-v8a/libstockfish.so
    shutil.copy(STOCKFISH, os.path.join(OUT, "lib", "arm64-v8a", "libstockfish.so"))

    # 4. javac（核心用桌面 JDK 编译；MainActivity 用 android.jar）
    javac = [JAVAC, "-encoding", "UTF-8", "--release", "11",
             "-cp", JARS_COMPILE, "-d", os.path.join(OUT, "classes")]
    core_dir = os.path.join(SRC, "stfchess", "core")
    core = [os.path.join(core_dir, f) for f in sorted(os.listdir(core_dir)) if f.endswith(".java")]
    run(javac + core)
    run([JAVAC, "-encoding", "UTF-8", "--release", "11",
         "-cp", os.pathsep.join([AJAR, JARS_COMPILE, os.path.join(OUT, "classes")]),
         "-d", os.path.join(OUT, "classes"),
         os.path.join(SRC, "stfchess", "app", "MainActivity.java")])

    # 5. d8 -> classes.dex（org.json 用系统框架自带的）
    #    规避 D8 对部分 jar 的兼容问题：库解包后连同自己的 class 打成单个 zip 喂给 D8
    import zipfile
    lib_dir = os.path.join(OUT, "libclasses")
    for jar in LIB_JARS:
        with zipfile.ZipFile(jar) as z:
            z.extractall(lib_dir)
    allzip = os.path.join(OUT, "all-classes.zip")
    with zipfile.ZipFile(allzip, "w", zipfile.ZIP_DEFLATED) as z:
        for root_dir in [os.path.join(OUT, "classes"), lib_dir]:
            for dirpath, _, files in os.walk(root_dir):
                for f in files:
                    fp = os.path.join(dirpath, f)
                    arc = os.path.relpath(fp, root_dir).replace("\\", "/")
                    if arc.startswith("META-INF/") or arc == "module-info.class":
                        continue
                    if not arc.endswith(".class"):
                        continue
                    z.write(fp, arc)
    d8cp = os.path.join(BT, "lib", "d8.jar")
    run([JAVA, "-cp", d8cp, "com.android.tools.r8.D8",
         "--release", "--lib", AJAR, "--min-api", "24",
         "--output", os.path.join(OUT, "dex"), allzip])

    # 6. aapt 打包资源/清单/资产
    manifest = os.path.join(ROOT, "android", "AndroidManifest.xml")
    run([AAPT, "package", "-f", "-m",
         "-M", manifest,
         "-S", os.path.join(OUT, "res"),
         "-A", os.path.join(OUT, "assets"),
         "-I", AJAR,
         "-F", os.path.join(OUT, "apk", "base.apk")])

    # 7. 注入 classes.dex 与引擎 .so
    shutil.copy(os.path.join(OUT, "dex", "classes.dex"), os.path.join(OUT, "classes.dex"))
    run([JAR, "uf", "apk/base.apk", "classes.dex"])
    run([JAR, "uf", "apk/base.apk", "lib/arm64-v8a/libstockfish.so"])

    # 8. 对齐 + 签名
    run([ZIPALIGN, "-f", "4", "apk/base.apk", "apk/aligned.apk"])
    if not os.path.exists(KEYSTORE):
        run([KEYTOOL, "-genkeypair", "-v", "-keystore", KEYSTORE,
             "-alias", "stfchess", "-storepass", "stfchess", "-keypass", "stfchess",
             "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
             "-dname", "CN=stfchess,O=stfchess,C=CN"])
    apk_out = os.path.join(ROOT, "android", "stfchess-android.apk")
    run([APKSIGNER, "sign",
         "--ks", KEYSTORE, "--ks-pass", "pass:stfchess",
         "--key-pass", "pass:stfchess", "--out", apk_out, "apk/aligned.apk"])
    run([APKSIGNER, "verify", apk_out])
    print("APK 构建完成:", apk_out, os.path.getsize(apk_out), "bytes")


if __name__ == "__main__":
    main()
