#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DF 一键数据服务器
--------------------------------------------------------------------------
在项目目录启动后：
  1. 作为静态服务器托管 DF 网页（http://127.0.0.1:8000/）；
  2. 提供数据接口，把每次改动自动写入同目录 deepseek-folder-data.json ——
     网页每次启动时先读取该文件恢复数据。这份文件就是 DeepSeek Folder 的“本地记忆”，
     换浏览器 / 清缓存 / 换端口都不会丢。

用法：
  python server.py            # 默认端口 8000
  python server.py 8080       # 指定端口
  （或直接双击 start-deepseek-folder.cmd）

访问控制（v0.3.2 起）：
  /api/state 是本机回环上的无鉴权写接口，若不设防，用户浏览任意网站时该网站都能
  直接 PUT 覆盖 deepseek-folder-data.json（简单请求不触发 CORS 预检，写入照样生效）。因此：
    1) Host 必须是回环地址（防 DNS rebinding）；
    2) Origin 必须同源，且必须携带页面内联注入的会话 Token（防跨站请求伪造）。
  页面由本服务器托管，Token 由 index.html 占位符在响应时替换，正常使用无感。
"""
import json
import os
import re
import secrets
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from urllib.parse import unquote as urllib_parse_unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT, 'deepseek-folder-data.json')
# v0.5.0 改名前的旧数据文件名（用于自动迁移，迁移后旧文件保留）
LEGACY_DATA_FILES = ('dsf-data.json',)
API_PATH = '/api/state'
INDEX_FILE = 'index.html'
TOKEN_PLACEHOLDER = '__DEEPSEEK_FOLDER_TOKEN__'
SESSION_TOKEN = secrets.token_hex(16)
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '[::1]', '::1')

# 静态托管的最小 MIME 表（SimpleHTTPRequestHandler 自带，这里只补 charset）
TEXT_MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}


def log(msg):
    """控制台输出（兼容 Windows 旧代码页）"""
    try:
        print(msg, flush=True)
    except Exception:
        try:
            sys.stdout.buffer.write((msg + '\n').encode('utf-8', 'replace'))
            sys.stdout.flush()
        except Exception:
            pass


class DFHandler(SimpleHTTPRequestHandler):
    server_version = 'DF/0.3.2'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 工具 ----------

    def _send(self, code, body=b'', ctype='application/json; charset=utf-8', extra=None):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _deny(self, message):
        """拒绝并关闭连接：避免“已读取一半的请求体”污染 keep-alive 连接"""
        self.close_connection = True
        self._send(403, json.dumps({'error': message}).encode('utf-8'),
                   extra={'Connection': 'close'})

    def _request_origin(self):
        """返回 (origin, host_ok, origin_ok)；origin 为 None 表示未携带 Origin"""
        origin = self.headers.get('Origin')
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        host = host or '127.0.0.1'
        host_ok = host in LOOPBACK_HOSTS
        if not origin:
            return None, host_ok, True
        try:
            parsed = urlparse(origin)
        except Exception:
            return origin, host_ok, False
        origin_host = (parsed.netloc or '').lower()
        origin_ok = bool(origin_host) and origin_host == (self.headers.get('Host') or '').lower()
        return origin, host_ok, origin_ok

    def _guard(self):
        """统一访问控制：回环 Host + 同源 Origin + 会话 Token。通过返回 True"""
        origin, host_ok, origin_ok = self._request_origin()
        if not host_ok:
            self._deny('forbidden host')
            return False
        if not origin_ok:
            self._deny('forbidden origin')
            return False
        if self.headers.get('X-DeepSeek-Folder-Token') != SESSION_TOKEN:
            self._deny('forbidden token')
            return False
        return True

    def _send_index_with_token(self):
        path = os.path.join(ROOT, INDEX_FILE)
        try:
            with open(path, 'r', encoding='utf-8') as fh:
                html = fh.read().replace(TOKEN_PLACEHOLDER, SESSION_TOKEN)
        except OSError as exc:
            self._send(500, json.dumps({'error': str(exc)}).encode('utf-8'))
            return
        self._send(200, html.encode('utf-8'), TEXT_MIME['.html'])

    def _path_forbidden(self):
        """静态托管的防护：目录穿越 / 隐藏目录 / node_modules / 数据文件本身"""
        rel = urlparse(self.path).path
        rel = urllib_parse_unquote(rel)
        if rel in ('', '/'):
            return False
        target = os.path.abspath(os.path.join(ROOT, rel.lstrip('/')))
        if target != ROOT and not target.startswith(ROOT + os.sep):
            return True  # 目录穿越
        if target == DATA_FILE:
            return True  # 数据文件不经静态托管外泄（页面走 /api/state）
        segments = os.path.relpath(target, ROOT).split(os.sep)
        for seg in segments:
            if seg.startswith('.') or seg == 'node_modules':
                return True
        return False

    def guess_type(self, path):
        """给文本资源补上 charset（否则某些浏览器会把中文当 latin-1 渲染）"""
        ctype = super().guess_type(path)
        ext = os.path.splitext(path)[1].lower()
        if ext in TEXT_MIME:
            return TEXT_MIME[ext]
        if ctype.startswith('text/') and 'charset' not in ctype:
            return ctype + '; charset=utf-8'
        return ctype

    def log_message(self, fmt, *args):
        # 数据接口的每次轮询不刷屏；普通静态请求保留默认日志
        if urlparse(self.path).path.startswith('/api/'):
            return
        super().log_message(fmt, *args)

    # ---------- 路由 ----------

    def do_OPTIONS(self):
        """预检：仅同源放行（跨站预检会因为拿不到允许头而失败）"""
        origin, host_ok, origin_ok = self._request_origin()
        if not host_ok:
            self._deny('forbidden host')
            return
        if origin and not origin_ok:
            self._deny('forbidden origin')
            return
        if origin:
            self._send(204, b'', extra={
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-DeepSeek-Folder-Token',
                'Access-Control-Max-Age': '600',
                'Vary': 'Origin',
            })
        else:
            self._send(204, b'')

    def do_GET(self):
        path = urlparse(self.path).path
        if path == API_PATH:
            if not self._guard():
                return
            try:
                if os.path.exists(DATA_FILE):
                    with open(DATA_FILE, 'r', encoding='utf-8') as fh:
                        body = fh.read()
                else:
                    body = 'null'  # 尚无数据文件
                self._send(200, body.encode('utf-8'))
            except Exception as exc:
                self._send(500, json.dumps({'error': str(exc)}).encode('utf-8'))
            return
        if path == '/' or path == '/' + INDEX_FILE:
            origin, host_ok, origin_ok = self._request_origin()
            if not host_ok or not origin_ok:
                self._deny('forbidden host')
                return
            self._send_index_with_token()
            return
        if self._path_forbidden():
            self._send(403, b'{"error":"forbidden"}')
            return
        super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != API_PATH:
            self._send(405, b'{"error":"method not allowed"}')
            return
        if not self._guard():
            return
        # GET/PUT 都需要校验 JSON 合法性；同时用唯一的临时文件，避免并发写互相截断
        try:
            length = int(self.headers.get('Content-Length') or 0)
            payload = self.rfile.read(length)
            json.loads(payload.decode('utf-8'))  # 先校验 JSON 合法性
            tmp = '%s.%d.%d.tmp' % (DATA_FILE, os.getpid(), threading.get_ident())
            try:
                with open(tmp, 'wb') as fh:
                    fh.write(payload)
                os.replace(tmp, DATA_FILE)  # 原子替换，避免写到一半损坏
            except Exception:
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                raise
            self._send(200, b'{"ok":true}')
        except Exception as exc:
            self._send(500, json.dumps({'error': str(exc)}).encode('utf-8'))


def _open_browser(url):
    try:
        webbrowser.open(url, new=2)
    except Exception:
        pass


def ensure_data_file():
    """首次启动时创建空数据文件：
    让“服务器模式是否生效”可一眼确认（目录里出现 deepseek-folder-data.json）。

    v0.5.0 项目改名（DSF → DeepSeek Folder）：若新数据文件不存在但旧文件
    （dsf-data.json）在，则从旧文件迁移内容，旧文件保留以便回退旧版本。
    """
    if os.path.exists(DATA_FILE):
        return

    for legacy_name in LEGACY_DATA_FILES:
        legacy = os.path.join(ROOT, legacy_name)
        if not os.path.exists(legacy):
            continue
        try:
            with open(legacy, 'r', encoding='utf-8') as fh:
                payload = fh.read()
            json.loads(payload)  # 校验是合法 JSON 再迁移
            tmp = DATA_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as fh:
                fh.write(payload)
            os.replace(tmp, DATA_FILE)
            log('已从旧数据文件迁移：%s → %s（旧文件保留）' % (legacy_name, os.path.basename(DATA_FILE)))
            return
        except Exception as exc:
            log('旧数据文件迁移失败（将新建空数据文件）：%s' % exc)

    import time
    base = {
        'v': 1,
        'savedAt': int(time.time() * 1000),
        'folders': [],
        'sessions': [],
        'recentClosed': [],
        'settings': {'sidebarCollapsed': False, 'lastImportFolderId': ''}
    }
    tmp = DATA_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(base, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


def main():
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            log('用法：python server.py [端口]，默认 8000')
            sys.exit(1)
    port = int(os.environ.get('DEEPSEEK_FOLDER_PORT', port))

    try:
        server = ThreadingHTTPServer(('127.0.0.1', port), DFHandler)
    except OSError:
        log('端口 %d 被占用：请换端口（python server.py 8080），'
            '或先关闭占用该端口的程序。' % port)
        sys.exit(1)

    ensure_data_file()

    log('')
    log('=====================================================')
    log('  DeepSeek Folder 服务器已启动')
    log('  打开：   http://127.0.0.1:%d/' % port)
    log('  数据文件： %s' % DATA_FILE)
    log('  关闭：   在此窗口按 Ctrl+C')
    log('=====================================================')
    log('')
    log('提示：每次改动都会自动保存到上面的数据文件；')
    log('重启电脑后请再次双击 start-deepseek-folder.cmd 打开，数据会自动恢复。')
    log('')

    url = 'http://127.0.0.1:%d/' % port
    # 稍等片刻让服务器就绪，再自动打开默认浏览器（DEEPSEEK_FOLDER_NO_BROWSER=1 可关闭）
    if os.environ.get('DEEPSEEK_FOLDER_NO_BROWSER') != '1':
        threading.Timer(1.0, lambda: _open_browser(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('已停止。数据已保存在 deepseek-folder-data.json。')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
