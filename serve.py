#!/usr/bin/env python3
"""
Локальный сервер для Timeline Viewer без кэширования.

Обычный `python3 -m http.server` не запрещает браузеру кэшировать файлы, и
после обновления проекта браузер может продолжать использовать старые
JS-модули (версия в шапке не меняется, новые функции "не работают").
Этот сервер отдаёт заголовок Cache-Control: no-store, так что каждая
перезагрузка страницы получает свежие файлы.

Запуск:   python3 serve.py            (порт 8080, только этот компьютер)
          python3 serve.py 9000       (другой порт)
          python3 serve.py 8080 0.0.0.0   (доступ из локальной сети)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'
    root = Path(__file__).resolve().parent
    handler = partial(NoCacheHandler, directory=str(root))
    with ThreadingHTTPServer((host, port), handler) as httpd:
        print(f'Timeline Viewer: http://{"localhost" if host == "127.0.0.1" else host}:{port}/index.html  (Ctrl+C — остановить)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nОстановлено.')


if __name__ == '__main__':
    main()
