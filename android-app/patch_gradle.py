#!/usr/bin/env python3
"""Patcht das von Capacitor erzeugte android/app/build.gradle:
   - Release-Signatur aus Umgebungsvariablen (Keystore aus GitHub-Secrets)
   - versionName / versionCode
Aufruf: patch_gradle.py <build.gradle> <versionName> <versionCode> <mit_signatur: 1|0>"""
import re, sys
path, vname, vcode, sign = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
s = open(path, encoding="utf-8").read()
s, n1 = re.subn(r'versionCode\s+\d+', f'versionCode {int(vcode)}', s, count=1)
s, n2 = re.subn(r'versionName\s+"[^"]*"', f'versionName "{vname}"', s, count=1)
assert n1 == 1 and n2 == 1, "versionCode/versionName nicht gefunden"
if sign:
    block = '''    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_PATH"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
'''
    assert "    buildTypes {" in s, "buildTypes nicht gefunden"
    s = s.replace("    buildTypes {", block + "    buildTypes {", 1)
    assert "        release {\n            minifyEnabled" in s, "release-Block nicht gefunden"
    s = s.replace("        release {\n            minifyEnabled", "        release {\n            signingConfig signingConfigs.release\n            minifyEnabled", 1)
open(path, "w", encoding="utf-8").write(s)
print("build.gradle gepatcht:", vname, vcode, "signiert" if sign else "unsigniert")
