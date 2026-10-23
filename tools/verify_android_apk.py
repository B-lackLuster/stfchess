"""Offline checks for the built APK; does not claim Android runtime validation.

Run apksigner separately to verify APK signatures.
"""
import argparse
import hashlib
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def dex_method_refs(data):
    """Read method identifiers to catch known Android 7-incompatible references."""
    assert data[:4] == b"dex\n", "Missing DEX header"
    string_count, string_offset = struct.unpack_from("<II", data, 56)
    strings = []
    for index in range(string_count):
        offset = struct.unpack_from("<I", data, string_offset + 4 * index)[0]
        # Skip the UTF-16 length's unsigned LEB128 encoding.
        while data[offset] & 0x80:
            offset += 1
        offset += 1
        strings.append(data[offset:data.index(b"\0", offset)].decode("utf-8", "replace"))
    type_count, type_offset = struct.unpack_from("<II", data, 64)
    types = [strings[struct.unpack_from("<I", data, type_offset + 4 * i)[0]]
             for i in range(type_count)]
    count, offset = struct.unpack_from("<II", data, 88)
    for index in range(count):
        class_index, _, name_index = struct.unpack_from("<HHI", data, offset + 8 * index)
        yield types[class_index], strings[name_index]


def verify(apk):
    with zipfile.ZipFile(apk) as package:
        assert package.testzip() is None, "Corrupt APK ZIP entry"
        for filename in ["index.html", "app.js", "style.css", "icon.png"]:
            entry = "assets/www/index.html" if filename == "index.html" else "assets/www/static/" + filename
            assert package.read(entry) == (ROOT / "static" / filename).read_bytes(), "Stale asset: " + entry
        print("PASS ZIP integrity and all four packaged UI assets")
        engine = package.read("lib/arm64-v8a/libstockfish.so")
        assert engine[:4] == b"\x7fELF" and engine[4] == 2, "Engine must be ELF64"
        assert struct.unpack_from("<H", engine, 18)[0] == 183, "Engine must be AArch64"
        print("PASS packaged ARM64 engine architecture")
        prohibited = {("Ljava/lang/Process;", "isAlive"), ("Ljava/lang/String;", "join")}
        for name in package.namelist():
            if name.endswith(".dex"):
                bad = set(dex_method_refs(package.read(name))) & prohibited
                assert not bad, f"Known API 26 calls incompatible with minimum API 24: {bad}"
        print("PASS DEX check for known Android 7 API incompatibilities")
    print("APK SHA256:", hashlib.sha256(apk.read_bytes()).hexdigest())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", nargs="?", type=Path, default=ROOT / "android" / "stfchess-android.apk")
    verify(parser.parse_args().apk)
