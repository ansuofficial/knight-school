#!/usr/bin/env python3
"""Build index.html, the whole game in one file, from the sources in src/.

    python3 build.py
    python3 build.py --url https://example.com/knight-school/

The game needs no install or bundler: this script only joins src/page.html, src/game.js,
src/pieces.js and src/three.min.js, and adds the page head (title, icons, link preview tags).
--url is the address the game will live at. Link previews on LinkedIn and X need the
full address of og-image.png, so pass it once you know where the game is hosted.
"""
import argparse
import base64
import html
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "src"

TITLE = "Knight School"
DESCRIPTION = "Learn chess one move at a time. Short hands-on lessons on a 3D wooden board, then friendly games with a coach who explains every move."
IMAGE_ALT = "A carved wooden chess knight on a cream card, with the words: Learn chess, one move at a time."
THEME = "#F7F3EA"


def need(text, mark, where):
    """Stop with a clear message unless `mark` appears exactly once in `where`."""
    n = text.count(mark)
    if n == 0:
        raise SystemExit(f"build.py: {where} is missing its {mark} placeholder")
    if n > 1:
        raise SystemExit(f"build.py: {where} has {mark} {n} times, but it must appear exactly once")


def build(url):
    page = (SRC / "page.html").read_text(encoding="utf-8")
    game = (SRC / "game.js").read_text(encoding="utf-8")
    art = (SRC / "pieces.js").read_text(encoding="utf-8")
    three = (SRC / "three.min.js").read_text(encoding="utf-8")
    need(page, "/*__TITLE__*/", "src/page.html")
    need(page, "/*__GAME__*/", "src/page.html")
    need(game, "/*__ART__*/", "src/game.js")
    # The script is written straight into the page, so a closing script tag inside it would end it early.
    for name, code in (("src/three.min.js", three), ("src/game.js", game), ("src/pieces.js", art)):
        if "</script" in code.lower():
            raise SystemExit(f"build.py: {name} contains </script, which would break index.html")

    # three.js draws the 3D board. It is copied into the page instead of loaded from a CDN, so the game makes
    # no requests beyond the font and still runs when index.html is opened straight from disk.
    script = three.strip() + ";\n" + game.replace("/*__ART__*/", art.strip()).strip()
    doc = page.replace("/*__TITLE__*/", html.escape(TITLE)).replace("/*__GAME__*/", script)

    # page.html is the title, fonts and styles, then the <main> app and its script.
    cut = doc.index("<main")
    head, body = doc[:cut].strip(), doc[cut:].strip()

    base = url.strip()
    if base and not base.endswith("/"):
        base += "/"
    icon = base64.b64encode((SRC / "favicon.png").read_bytes()).decode("ascii")
    attr = lambda s: html.escape(s, quote=True)
    meta = [
        f'<meta name="description" content="{attr(DESCRIPTION)}">',
        f'<meta name="theme-color" content="{THEME}">',
        f'<link rel="icon" type="image/png" href="data:image/png;base64,{icon}">',
        f'<link rel="apple-touch-icon" href="{base}apple-touch-icon.png">',
        '<meta property="og:type" content="website">',
        f'<meta property="og:title" content="{attr(TITLE)}">',
        f'<meta property="og:description" content="{attr(DESCRIPTION)}">',
        f'<meta property="og:image" content="{base}og-image.png">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        f'<meta property="og:image:alt" content="{attr(IMAGE_ALT)}">',
        '<meta name="twitter:card" content="summary_large_image">',
    ]
    if base:
        # Without the slash, so the shared link is the address people see, not one that redirects.
        meta.append(f'<meta property="og:url" content="{attr(base.rstrip("/"))}">')

    out = "\n".join([
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        *meta,
        head,
        "</head>",
        "<body>",
        body,
        "</body>",
        "</html>",
        "",
    ])
    (HERE / "index.html").write_text(out, encoding="utf-8")
    print(f"wrote index.html ({len(out.encode('utf-8')) // 1024} KB)" + (f" for {base}" if base else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build index.html from src/.")
    ap.add_argument("--url", default="", help="the address the game will live at, for link previews")
    build(ap.parse_args().url)
