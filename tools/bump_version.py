"""更新網站版本號（每次上傳前執行）

用法（在 TripPlanner 資料夾執行）：
    python tools/bump_version.py            # 自動：今天第一次＝日期-1，同一天再執行就遞增（-2、-3…）
    python tools/bump_version.py --set 2026-11-08-1   # 指定版本號

會更新：
- version.json                    {"version": "..."}
- js/version.js                   APP_VERSION
- index.html                      css/style.css?v=、js/main.js?v=
- 所有 JS 檔（js/ 底下）的相對路徑 import（含動態 import）網址的 ?v=
  （所有檔案必須是同一個版本號，否則同一個模組會被載入兩份）
外部網址（Firebase、SortableJS 等）不處理。
"""
import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# from './x.js'、import './x.js'、import('./x.js')（只處理 ./ 或 ../ 開頭的相對路徑）
IMPORT_RE = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}/[^'"?\s]+?\.js)(?:\?v=[^'"]*)?\2""")
HTML_RE = re.compile(r"""((?:href|src)=")((?:css|js)/[^"?]+?\.(?:css|js))(?:\?v=[^"]*)?(")""")


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def next_version(old):
    today = datetime.date.today().isoformat()
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2})-(\d+)', old or '')
    if m and m.group(1) == today:
        return f'{today}-{int(m.group(2)) + 1}'
    return f'{today}-1'


def main():
    vj = os.path.join(ROOT, 'version.json')
    old = ''
    if os.path.exists(vj):
        try:
            old = json.loads(read(vj)).get('version', '')
        except Exception:
            old = ''
    if len(sys.argv) >= 3 and sys.argv[1] == '--set':
        ver = sys.argv[2]
    else:
        ver = next_version(old)
    if not re.fullmatch(r'[0-9A-Za-z._-]+', ver):
        sys.exit(f'版本號格式不正確：{ver}')

    write(vj, json.dumps({'version': ver}, ensure_ascii=False) + '\n')

    changed = []
    # js/version.js 的常數
    vjs = os.path.join(ROOT, 'js', 'version.js')
    s = read(vjs)
    s2, n = re.subn(r"export const APP_VERSION = '[^']*';", f"export const APP_VERSION = '{ver}';", s)
    if n != 1:
        sys.exit('js/version.js 找不到 APP_VERSION')
    write(vjs, s2)

    # index.html
    ih = os.path.join(ROOT, 'index.html')
    s = read(ih)
    s2, n = HTML_RE.subn(lambda m: f'{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}', s)
    if s2 != s:
        write(ih, s2)
    changed.append(f'index.html（{n} 個網址）')

    # 所有 JS 檔的 import
    total = 0
    files = 0
    for dirpath, _, names in os.walk(os.path.join(ROOT, 'js')):
        for name in names:
            if not name.endswith('.js'):
                continue
            p = os.path.join(dirpath, name)
            s = read(p)
            s2, n = IMPORT_RE.subn(lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}?v={ver}{m.group(2)}', s)
            if s2 != s:
                write(p, s2)
            if n:
                files += 1
                total += n

    # 檢查：不應該還有沒帶版本號（或版本號不同）的相對 import
    bad = []
    for dirpath, _, names in os.walk(os.path.join(ROOT, 'js')):
        for name in names:
            if name.endswith('.js'):
                p = os.path.join(dirpath, name)
                for m in re.finditer(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}/[^'"]+)['"]""", read(p)):
                    if not m.group(1).endswith(f'?v={ver}'):
                        bad.append(f'{os.path.relpath(p, ROOT)}: {m.group(1)}')
    print(f'版本號：{old or "（無）"} → {ver}')
    print(f'更新：version.json、js/version.js、{changed[0]}、{files} 個 JS 檔（{total} 個 import）')
    if bad:
        print('⚠ 以下 import 沒有正確的版本號：')
        print('\n'.join(bad))
        sys.exit(1)


if __name__ == '__main__':
    main()
